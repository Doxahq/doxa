import { describe, expect, it } from "vitest";

import {
  createDocsSearchIndexKey,
  isDocsSearchIndexKeyOfSite,
  isRemoteSearchProvider,
  withoutSearchTarget,
} from "@doxahq/contracts/docs-search";
import {
  FREE_PLAN_SEARCH_POLICY,
  PAID_PLAN_SEARCH_POLICY,
  resolveSearchProvider,
} from "@doxahq/contracts/entitlements";

describe("search provider rules", () => {
  it("gives each plan its default", () => {
    expect(resolveSearchProvider(undefined, FREE_PLAN_SEARCH_POLICY)).toBe("minisearch");
    expect(resolveSearchProvider(undefined, PAID_PLAN_SEARCH_POLICY)).toBe("typesense");
  });

  it("lets a paid site choose, and never lets a free site exceed its plan", () => {
    expect(resolveSearchProvider("minisearch", PAID_PLAN_SEARCH_POLICY)).toBe("minisearch");
    expect(resolveSearchProvider("typesense", FREE_PLAN_SEARCH_POLICY)).toBe("minisearch");
  });

  it("knows which providers are remote", () => {
    expect(isRemoteSearchProvider("typesense")).toBe(true);
    expect(isRemoteSearchProvider("minisearch")).toBe(false);
  });
});

describe("search index name", () => {
  const siteId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";

  it("is new for each build, so a delete cannot hit a newer index", () => {
    const first = createDocsSearchIndexKey({ siteId, versionId });
    const second = createDocsSearchIndexKey({ siteId, versionId });
    expect(first).toMatch(
      /^s_11111111111141118111111111111111_22222222222242228222222222222222_[a-f0-9]{32}$/,
    );
    expect(first).not.toBe(second);
  });

  it("accepts only IDs", () => {
    expect(() => createDocsSearchIndexKey({ siteId: "../x", versionId })).toThrow();
  });

  it("belongs to one site", () => {
    const indexKey = createDocsSearchIndexKey({ siteId, versionId });
    expect(isDocsSearchIndexKeyOfSite(indexKey, siteId)).toBe(true);
    expect(isDocsSearchIndexKeyOfSite(indexKey, versionId)).toBe(false);
    expect(isDocsSearchIndexKeyOfSite("t_real", siteId)).toBe(false);
  });
});

describe("search target in a resolution", () => {
  it("is removed for anything that feeds a cache key", () => {
    expect(
      withoutSearchTarget({
        siteId: "s",
        searchProvider: "typesense",
        searchIndexKey: "k",
      }),
    ).toEqual({ siteId: "s" });
  });
});
