import { describe, expect, it } from "vitest";
import {
  parseSiteConfigStrict,
  parseSiteConfigLenient,
  parseThemeFileStrict,
  validateInputLimits,
} from "../src";

const link = { label: "Page", href: "/page" };

describe("size and count boundaries", () => {
  it.each([
    [{ name: "x".repeat(81) }, "/name", "too_long"],
    [{ description: "x".repeat(301) }, "/description", "too_long"],
    [
      { navbar: { links: [{ ...link, label: "x".repeat(41) }] } },
      "/navbar/links/0/label",
      "too_long",
    ],
    [
      { navbar: { cta: { ...link, label: "x".repeat(31) } } },
      "/navbar/cta/label",
      "too_long",
    ],
    [
      { footer: { groups: [{ title: "x".repeat(41) }] } },
      "/footer/groups/0/title",
      "too_long",
    ],
    [{ seo: { keywords: ["x".repeat(41)] } }, "/seo/keywords/0", "too_long"],
    [
      { seo: { keywords: Array.from({ length: 21 }, () => "key") } },
      "/seo/keywords",
      "too_many_items",
    ],
    [
      {
        footer: {
          groups: Array.from({ length: 7 }, () => ({ title: "Group" })),
        },
      },
      "/footer/groups",
      "too_many_items",
    ],
    [
      {
        footer: {
          groups: [
            { title: "Group", links: Array.from({ length: 13 }, () => link) },
          ],
        },
      },
      "/footer/groups/0/links",
      "too_many_items",
    ],
  ])("reports all configured bounds: %j", (input, path, code) => {
    const result = parseSiteConfigStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path, code })]),
      );
  });
  it("measures UTF-8 bytes, not characters", () => {
    expect(validateInputLimits({ name: "é".repeat(33_000) })[0].code).toBe(
      "config_too_large",
    );
  });
  it("validates the separate theme file shape and byte limit", () => {
    expect(
      parseThemeFileStrict({
        name: "Theme",
        tokens: { light: { primary: "#abc" } },
      }).ok,
    ).toBe(true);
    const oversized = parseThemeFileStrict({ name: "é".repeat(17_000) });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok)
      expect(oversized.issues[0].code).toBe("invalid_theme_file");
    const wrong = parseThemeFileStrict({ extraCss: "body{}" });
    if (wrong.ok) throw new Error("Expected invalid input");
    expect(wrong.issues[0].code).toBe("unknown_key");
  });
  it.each(["extraCss", "scripts", "analytics", "html"])(
    "rejects executable config field %s",
    (key) => {
      const result = parseSiteConfigStrict({ [key]: "evil" });
      if (result.ok) throw new Error("Expected invalid input");
      expect(result.issues[0].code).toBe("unknown_key");
    },
  );
});

describe("bounded recovery without sibling loss", () => {
  it("removes each bad nested item once, regardless of the number of errors", () => {
    const input = {
      footer: {
        groups: [
          {
            title: "Group",
            links: [
              { label: 42, href: "javascript:x" },
              link,
              { label: null, href: "file:x" },
              { label: "Last", href: "/last" },
            ],
          },
        ],
      },
    };
    const result = parseSiteConfigLenient(input);
    expect(
      result.config.footer.groups[0].links.map((item) => item.href),
    ).toEqual(["/page", "/last"]);
  });
  it("strips an unknown array-item key without discarding that valid item", () => {
    const result = parseSiteConfigLenient({
      navbar: { links: [{ ...link, surprise: true }] },
    });
    expect(result.config.navbar.links).toHaveLength(1);
    expect(result.droppedPaths).toContain("/navbar/links/0/surprise");
  });
  it("handles more than 32 invalid keys in bounded passes and keeps valid siblings", () => {
    const input = {
      name: "Keep",
      ...Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`bad${index}`, true]),
      ),
    };
    const result = parseSiteConfigLenient(input);
    expect(result.config.name).toBe("Keep");
    expect(result.droppedPaths).toHaveLength(100);
  });
});
