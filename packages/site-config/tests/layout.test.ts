import { describe, expect, it } from "vitest";
import {
  docsLayout,
  parseSiteConfigLenient,
  parseSiteConfigStrict,
  resolveSiteConfig,
  sidebarPosition,
  siteConfigJsonSchema,
  toClientSiteConfig,
} from "../src";

describe("layout", () => {
  it("is absent unless a config sets it, and the sidebar then sits beside the content", () => {
    const config = resolveSiteConfig({});
    expect("layout" in config).toBe(false);
    expect(sidebarPosition(config)).toBe("beside-content");
  });

  it("keeps a chosen sidebar position, and fills the default inside an empty layout", () => {
    const edge = resolveSiteConfig({ layout: { sidebar: "page-edge" } });
    expect(edge.layout).toEqual({ sidebar: "page-edge", collapsibleGroups: false });
    expect(sidebarPosition(edge)).toBe("page-edge");
    expect(toClientSiteConfig(edge).layout).toEqual({ sidebar: "page-edge", collapsibleGroups: false });
    expect(resolveSiteConfig({ layout: {} }).layout).toEqual({
      sidebar: "beside-content",
      collapsibleGroups: false,
    });
  });

  it("rejects an unknown position or key with a pointer to it", () => {
    const result = parseSiteConfigStrict({ layout: { sidebar: "floating", width: 3 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["/layout/sidebar", "/layout/width"]),
    );
  });

  it("drops an invalid layout in lenient parsing and keeps the rest", () => {
    const result = parseSiteConfigLenient({ name: "Docs", layout: { sidebar: "floating" } });
    expect(result.config.name).toBe("Docs");
    expect(sidebarPosition(result.config)).toBe("beside-content");
  });

  it("is in the JSON schema for editors", () => {
    const schema = siteConfigJsonSchema() as { properties: Record<string, unknown> };
    expect(schema.properties.layout).toBeDefined();
  });

  it("puts the section tabs in the top bar for the page edge layout", () => {
    expect(docsLayout(resolveSiteConfig({}))).toEqual({
      sidebar: "beside-content",
      collapsibleGroups: false,
      sectionTabs: "below-navbar",
    });
    expect(docsLayout(resolveSiteConfig({ layout: { sidebar: "page-edge" } }))).toEqual({
      sidebar: "page-edge",
      collapsibleGroups: false,
      sectionTabs: "in-navbar",
    });
  });

  it("makes sidebar groups collapsible on request, and only then", () => {
    expect(docsLayout(resolveSiteConfig({})).collapsibleGroups).toBe(false);
    const config = resolveSiteConfig({ layout: { collapsibleGroups: true } });
    expect(config.layout).toEqual({ sidebar: "beside-content", collapsibleGroups: true });
    expect(docsLayout(config).collapsibleGroups).toBe(true);
    expect(parseSiteConfigStrict({ layout: { collapsibleGroups: "yes" } }).ok).toBe(false);
  });
});
