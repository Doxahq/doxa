import { describe, expect, it } from "vitest";
import {
  apiPlaygroundBaseUrlSchema,
  apiPlaygroundTransportSchema,
  parseSiteConfigStrict,
  parseSiteConfigLenient,
  resolveSiteConfig,
  createDefaultSiteConfig,
  toJsonPointer,
  fromJsonPointer,
} from "../src";

describe("shared strict validation", () => {
  it("fills defaults and uses the project name", () => {
    const config = resolveSiteConfig(
      createDefaultSiteConfig({ projectName: "Project Name" }),
    );
    expect(config.name).toBe("Project Name");
    expect(config.version).toBe(1);
    expect(config.theme.tokens.light.background).toBe("oklch(1 0 0)");
  });

  // The dashboard hides the AI assistant settings until chat follows billing
  // and the plan, so no site may get them on without asking for them.
  it("keeps the AI assistant off by default", () => {
    const off = { chat: false, chatWithPage: false, floatingInput: false };
    expect(resolveSiteConfig(createDefaultSiteConfig({ projectName: "Project" })).features.ai).toEqual(off);
    expect(resolveSiteConfig({}).features.ai).toEqual(off);
  });
  it("collects all issues with stable codes and escaped pointers", () => {
    const result = parseSiteConfigStrict({
      name: "a".repeat(81),
      theme: { primary: "</style>", tokens: { light: { "a/b~c": "#fff" } } },
      navbar: { links: [{ label: "Unsafe", href: "javascript:alert(1)" }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ code, path }) => ({ code, path }))).toEqual(
      expect.arrayContaining([
        { code: "too_long", path: "/name" },
        { code: "invalid_color", path: "/theme/primary" },
        { code: "unknown_key", path: "/theme/tokens/light/a~1b~0c" },
        { code: "unsafe_href_protocol", path: "/navbar/links/0/href" },
      ]),
    );
    expect(JSON.stringify(result.issues)).not.toContain("alert(1)");
    expect(JSON.stringify(result.issues)).not.toContain("</style>");
  });
  it.each([
    [{ navbar: { links: [{}] } }, "required"],
    [{ name: 12 }, "invalid_type"],
    [{ theme: { fonts: { body: "No font" } } }, "unknown_font"],
    [{ theme: { preset: "No preset" } }, "unknown_preset"],
    [
      {
        navbar: {
          links: Array.from({ length: 9 }, () => ({
            label: "Link",
            href: "/",
          })),
        },
      },
      "too_many_items",
    ],
    [{ description: "x".repeat(65 * 1024) }, "config_too_large"],
  ])("rejects input with %s", (input, code) => {
    const result = parseSiteConfigStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.some((issue) => issue.code === code)).toBe(true);
  });
  it("limits nesting before parsing", () => {
    let input: unknown = {};
    for (let index = 0; index < 9; index++) input = { nested: input };
    const result = parseSiteConfigStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].code).toBe("too_deep");
  });
  it("round trips JSON pointers", () => {
    const path = ["navbar", "a/b", "~name"];
    expect(fromJsonPointer(toJsonPointer(path))).toEqual(path);
  });
});

describe("lenient recovery", () => {
  it("drops an invalid array item while preserving siblings and input", () => {
    const input = {
      name: "Keep me",
      navbar: {
        links: [
          { label: "Good", href: "/good" },
          { label: "Bad", href: "javascript:x" },
          { label: "Last", href: "/last" },
        ],
      },
      theme: { primary: "invalid" },
    };
    const result = parseSiteConfigLenient(input);
    expect(result.config.name).toBe("Keep me");
    expect(result.config.navbar.links.map((link) => link.href)).toEqual([
      "/good",
      "/last",
    ]);
    expect(result.droppedPaths).toContain("/navbar/links/1");
    expect(input.navbar.links).toHaveLength(3);
    expect(result.config.theme.primary).toBeNull();
  });
  it.each([null, undefined, 12, true, "bad", 1n, Symbol("bad")])(
    "never throws on %s",
    (input) => {
      expect(() => parseSiteConfigLenient(input)).not.toThrow();
      expect(parseSiteConfigLenient(input).config).toEqual(
        resolveSiteConfig({}),
      );
    },
  );
  it("bounds work on cyclic, deeply nested, and accessor inputs", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });
    expect(() => parseSiteConfigLenient(cyclic)).not.toThrow();
    expect(() => parseSiteConfigLenient(accessor)).not.toThrow();
  });
  it("does not copy prototype keys into the result", () => {
    const result = parseSiteConfigLenient(
      JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"name":"Safe"}',
      ),
    );
    expect(result.config.name).toBe("Safe");
    expect(Object.hasOwn(result.config, "__proto__")).toBe(false);
    expect(Object.hasOwn(result.config, "constructor")).toBe(false);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });
});

describe("visible text", () => {
  it.each([
    ["/navbar/links/0/label", { navbar: { links: [{ label: " ", href: "/" }] } }],
    ["/navbar/cta/label", { navbar: { cta: { label: "", href: "/" } } }],
    ["/footer/groups/0/title", { footer: { groups: [{ title: "", links: [] }] } }],
    ["/seo/keywords/0", { seo: { keywords: [""] } }],
  ])("rejects an empty value at %s as required", (path, input) => {
    const result = parseSiteConfigStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path, code: "required" }),
      );
  });
});

// SECURITY REGRESSION GUARDRAIL (SEC-010): the playground target is an owner-set http(s) URL or a local path.
describe("features.apiPlaygroundTransport", () => {
  it.each(["proxy", "browser"])("accepts %s", (value) => {
    expect(apiPlaygroundTransportSchema.safeParse(value).success).toBe(true);
  });

  it("refuses any other value", () => {
    expect(apiPlaygroundTransportSchema.safeParse("server").success).toBe(false);
  });
});

describe("features.apiPlaygroundBaseUrl", () => {
  it.each(["https://api.acme.com/v1", "http://localhost:8787", "/api/echo"])("accepts %s", (value) => {
    expect(apiPlaygroundBaseUrlSchema.safeParse(value).success).toBe(true);
  });

  it.each(["javascript:alert(1)", "//evil.example", "api/v1", "https://user:secret@api.acme.com", "ftp://acme.com", ""])(
    "refuses %j",
    (value) => {
      expect(apiPlaygroundBaseUrlSchema.safeParse(value).success).toBe(false);
    },
  );
});
