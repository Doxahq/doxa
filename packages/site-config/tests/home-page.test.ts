import { describe, expect, it } from "vitest";
import {
  parseSiteConfigLenient,
  parseSiteConfigStrict,
  resolveHomeHref,
  resolveSiteConfig,
  siteConfigJsonSchema,
  toClientSiteConfig,
} from "../src";

const pages = new Set(["/intro", "/guides/setup"]);
const hasPage = (href: string) => pages.has(href);

describe("homePage", () => {
  it("is absent unless a config sets it", () => {
    expect("homePage" in resolveSiteConfig({})).toBe(false);
  });

  it("keeps a chosen page as a normalized href, also for the client", () => {
    const config = resolveSiteConfig({ homePage: "/guides/setup/" });
    expect(config.homePage).toBe("/guides/setup");
    expect(toClientSiteConfig(config).homePage).toBe("/guides/setup");
  });

  it("rejects a link to another site", () => {
    const result = parseSiteConfigStrict({ homePage: "https://example.com/intro" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ path }) => path)).toContain("/homePage");
  });

  it("drops an invalid value in lenient parsing and keeps the rest", () => {
    const result = parseSiteConfigLenient({ name: "Docs", homePage: 42 });
    expect(result.config.name).toBe("Docs");
    expect(result.config.homePage).toBeUndefined();
  });

  it("is in the JSON schema for editors", () => {
    const schema = siteConfigJsonSchema() as { properties: Record<string, unknown> };
    expect(schema.properties.homePage).toBeDefined();
  });
});

describe("resolveHomeHref", () => {
  it("uses the chosen page when it exists, the root page too", () => {
    expect(resolveHomeHref({ homePage: "/guides/setup" }, hasPage, "/intro")).toBe("/guides/setup");
    expect(resolveHomeHref({ homePage: "/" }, (href) => href === "/", "/intro")).toBe("/");
  });

  it("uses the fallback without a choice, or when the chosen page is gone", () => {
    expect(resolveHomeHref({}, hasPage, "/intro")).toBe("/intro");
    expect(resolveHomeHref({ homePage: "/deleted" }, hasPage, "/intro")).toBe("/intro");
    expect(resolveHomeHref({}, hasPage, null)).toBeNull();
  });
});
