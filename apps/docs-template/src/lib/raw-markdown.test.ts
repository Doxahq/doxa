import { resolveSiteConfig } from "@doxahq/site-config";
import { describe, expect, test, vi } from "vitest";

import { tryRawMarkdownResponse } from "./raw-markdown";

vi.mock("@/src/lib/content/store", () => ({
  contentStore: { readRaw: vi.fn(async () => null) },
}));

describe("tryRawMarkdownResponse", () => {
  test("reads raw markdown from the request-scoped runtime source", async () => {
    const source = {
      getFeatureConfig: async () => resolveSiteConfig({}).features,
      getRawPage: vi.fn(async () => ({
        slug: "guide",
        href: "/guide",
        title: "Guide",
        description: "",
        sourcePath: "guide/index.mdx",
        body: "---\ntitle: Guide\n---\n\n# Guide",
      })),
    };

    const response = await tryRawMarkdownResponse("/guide.md", source);

    expect(source.getRawPage).toHaveBeenCalledWith("guide");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("# Guide");
  });

  test("returns 404 when the scoped version has no matching page", async () => {
    const source = {
      getRawPage: vi.fn(async () => null),
      getFeatureConfig: async () => resolveSiteConfig({}).features,
    };

    const response = await tryRawMarkdownResponse("/missing.md", source);

    expect(response?.status).toBe(404);
  });

  test("does not read raw content when the site's feature is disabled", async () => {
    const source = {
      getRawPage: vi.fn(async () => null),
      getFeatureConfig: async () =>
        resolveSiteConfig({ features: { rawMarkdown: false } }).features,
    };
    expect(await tryRawMarkdownResponse("/guide.md", source)).toBeNull();
    expect(source.getRawPage).not.toHaveBeenCalled();
  });
});
