import { describe, expect, it } from "vitest";
import { DOCS_WARM_HINT_PATH_LIMIT } from "@doxahq/contracts/docs-warm-job";
import { buildDocsWarmHint, changedPagePaths } from "../../src/services/docs-warm-hint";

const page = (slug: string, kind = "upsert") => ({
  path: slug ? `source/${slug}/index.mdx` : "source/index.mdx",
  kind,
});

describe("buildDocsWarmHint", () => {
  it("names the publisher's pool and the edited pages", () => {
    expect(
      buildDocsWarmHint({ region: "eu-west", changes: [page("guides/setup"), page("")] }),
    ).toEqual({ regions: ["eu-west"], paths: ["/", "/guides/setup"] });
  });

  it("sends no pages when the structure or the site settings change", () => {
    for (const other of ["settings/sections.json", "manifest.json", "settings/site.json"]) {
      expect(
        buildDocsWarmHint({ region: "us-east", changes: [page("intro"), { path: other, kind: "upsert" }] }),
      ).toEqual({ regions: ["us-east"] });
    }
  });

  it("skips deleted pages and images, and caps the pages", () => {
    const many = Array.from({ length: DOCS_WARM_HINT_PATH_LIMIT + 10 }, (_, index) => page(`p${String(index).padStart(3, "0")}`));
    const paths = changedPagePaths([...many, page("gone", "delete"), { path: "assets/logo.png", kind: "upsert" }]);

    expect(paths).toHaveLength(DOCS_WARM_HINT_PATH_LIMIT);
    expect(paths).not.toContain("/gone");
    expect(paths[0]).toBe("/p000");
  });

  it("sends no pages for a path it cannot classify", () => {
    expect(changedPagePaths([page("intro"), { path: "../etc/passwd", kind: "upsert" }])).toEqual([]);
  });

  it("is undefined when it has nothing to say", () => {
    expect(buildDocsWarmHint({})).toBeUndefined();
    expect(buildDocsWarmHint({ region: null, changes: [{ path: "settings/site.json", kind: "upsert" }] })).toBeUndefined();
  });

  it("names only the pages when the region is unknown", () => {
    expect(buildDocsWarmHint({ region: null, changes: [page("intro")] })).toEqual({ paths: ["/intro"] });
  });
});
