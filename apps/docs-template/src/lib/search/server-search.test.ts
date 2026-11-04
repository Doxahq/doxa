import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";
import {
  compileSearchArtifact,
  createSearchEngine,
  runtimeSearchArtifactSchema,
} from "@doxahq/docs-search";
import { describe, expect, test, vi } from "vitest";

import { utf8ByteLength } from "@/src/lib/utf8";

import { createSearchEngineCache, createServerSearch } from "./server-search";

const sourceArtifact = runtimeSearchArtifactSchema.parse({
  schemaVersion: 1,
  contentVersion: "version-1",
  documents: [
    {
      id: "/quickstart",
      slug: "/quickstart",
      title: "Quickstart",
      description: "Install Doxa",
      breadcrumb: [],
      section: "default",
      headings: ["Install"],
      keywords: ["doxa"],
      content: "Install Doxa from the command line.",
      lines: [
        { text: "Install Doxa from the command line.", anchor: "install" },
      ],
    },
  ],
});

describe("server documentation search", () => {
  test("prefers the prebuilt index and reuses it by content version", async () => {
    const source = createRuntimeSource({
      compiled: JSON.stringify(compileSearchArtifact(sourceArtifact)),
      raw: JSON.stringify(sourceArtifact),
    });
    const search = createServerSearch();

    await expect(search(source, "doxa", 8)).resolves.toMatchObject([
      { slug: "/quickstart", snippetAnchor: "install" },
    ]);
    await search(source, "install", 8);

    expect(source.getCompiledSearchIndex).toHaveBeenCalledTimes(2);
    expect(source.getSearchIndex).not.toHaveBeenCalled();
  });

  test("builds the source artifact when an older version has no prebuilt index", async () => {
    const source = createRuntimeSource({
      compiled: null,
      raw: JSON.stringify(sourceArtifact),
    });
    const search = createServerSearch();

    await expect(search(source, "command", 8)).resolves.toMatchObject([
      { slug: "/quickstart" },
    ]);
    expect(source.getSearchIndex).toHaveBeenCalledTimes(1);
  });

  test("searches legacy docs versions without a prebuilt index", async () => {
    const source = createRuntimeSource({
      compiled: null,
      raw: JSON.stringify({
        documents: [
          {
            title: "Legacy setup",
            href: "/legacy",
            text: "Install the legacy project.",
          },
        ],
      }),
    });

    await expect(
      createServerSearch()(source, "legacy", 8)
    ).resolves.toMatchObject([{ slug: "/legacy", title: "Legacy setup" }]);
  });
});

function createRuntimeSource(input: {
  compiled: string | null;
  raw: string | null;
}): DoxaDocsRuntimeSource {
  return {
    getCompiledSearchIndex: vi.fn(async () => input.compiled),
    getSearchIndex: vi.fn(async () => input.raw),
  } as unknown as DoxaDocsRuntimeSource;
}

describe("server search cache (M46: many sites in one isolate)", () => {
  test("keeps separate engines for two sites with the same content version", async () => {
    const search = createServerSearch();
    const siteA = createScopedSource(
      "site:site-a:version-a",
      artifactWith("version-1", "/alpha", "Alpha marker page")
    );
    const siteB = createScopedSource(
      "site:site-b:version-b",
      artifactWith("version-1", "/bravo", "Bravo marker page")
    );

    const resultsA = await search(siteA, "marker", 8);
    const resultsB = await search(siteB, "marker", 8);

    expect(resultsA.map((result) => result.slug)).toEqual(["/alpha"]);
    expect(resultsB.map((result) => result.slug)).toEqual(["/bravo"]);
    expect(search.cache.size).toBe(2);
    // A second call per site hits its own engine.
    expect(
      (await search(siteA, "marker", 8)).map((result) => result.slug)
    ).toEqual(["/alpha"]);
  });

  test("answers a cached published version without reading its index again", async () => {
    const search = createServerSearch();
    const site = createScopedSource(
      "site:site-a:version-a",
      artifactWith("version-1", "/alpha", "Alpha marker page")
    );

    await search(site, "marker", 8);
    const again = await search(site, "alpha", 8);

    expect(again.map((result) => result.slug)).toEqual(["/alpha"]);
    expect(site.getCompiledSearchIndex).toHaveBeenCalledTimes(1);
  });

  test("reads the index on every search for a host scope, which can move to a newer version", async () => {
    const search = createServerSearch();
    const host = createScopedSource(
      "host:docs.example.com",
      artifactWith("version-1", "/alpha", "Alpha marker page")
    );

    await search(host, "marker", 8);
    await search(host, "alpha", 8);

    expect(host.getCompiledSearchIndex).toHaveBeenCalledTimes(2);
    expect(search.cache.size).toBe(1);
  });

  test("never caches a source without a scope", async () => {
    const search = createServerSearch();
    const source = createRuntimeSource({
      compiled: JSON.stringify(compileSearchArtifact(sourceArtifact)),
      raw: null,
    });

    await search(source, "doxa", 8);
    expect(search.cache.size).toBe(0);
  });

  test("stays within the byte budget, evicting the least recently used", async () => {
    const indexes = Array.from({ length: 6 }, (_, index) =>
      createScopedSource(
        `site:site-${index}:version`,
        artifactWith(`version-${index}`, `/page-${index}`, "Budget marker")
      )
    );
    const oneIndexBytes = utf8ByteLength(
      (await indexes[0].getCompiledSearchIndex?.()) ?? ""
    );
    const search = createServerSearch({ maxCacheBytes: oneIndexBytes * 3 });

    for (const source of indexes) {
      await search(source, "budget", 8);
      expect(search.cache.totalBytes).toBeLessThanOrEqual(oneIndexBytes * 3);
    }
    expect(search.cache.size).toBeLessThanOrEqual(3);
  });

  test("does not cache one index above the whole budget", async () => {
    const source = createScopedSource(
      "site:big:version",
      artifactWith("version-big", "/big", "Large marker")
    );
    const search = createServerSearch({ maxCacheBytes: 16 });

    await expect(search(source, "marker", 8)).resolves.toMatchObject([
      { slug: "/big" },
    ]);
    expect(search.cache.size).toBe(0);
    expect(search.cache.totalBytes).toBe(0);
  });
});

describe("server search size limits (FS-M1)", () => {
  const indexBytes = async (source: DoxaDocsRuntimeSource) =>
    utf8ByteLength((await source.getCompiledSearchIndex?.()) ?? "");

  test("does not cache one site's index above the per-site share", async () => {
    const big = createScopedSource(
      "site:big:version",
      artifactWith("version-big", "/big", "Large marker")
    );
    const bytes = await indexBytes(big);
    const search = createServerSearch({
      maxCacheBytes: bytes * 10,
      maxEntryBytes: bytes - 1,
    });

    await expect(search(big, "marker", 8)).resolves.toMatchObject([
      { slug: "/big" },
    ]);
    expect(search.cache.size).toBe(0);
  });

  test("keeps other sites cached when a large index is searched", async () => {
    const smallArtifact = artifactWith("version-small", "/small", "Small");
    const bigArtifact = artifactWith(
      "version-big",
      "/big",
      "Large marker ".repeat(50)
    );
    const small = createScopedSource("site:small:version", smallArtifact);
    const big = createScopedSource("site:big:version", bigArtifact);
    const search = createServerSearch({
      maxCacheBytes: compiledBytes(bigArtifact) + 1,
      maxEntryBytes: compiledBytes(smallArtifact) * 2,
    });

    await search(small, "small", 8);
    await search(big, "marker", 8);
    await search(small, "small", 8);

    expect(small.getCompiledSearchIndex).toHaveBeenCalledTimes(1);
  });

  test("answers no results above the read limit, never parsing or building", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = createRuntimeSource({
      compiled: "x".repeat(200),
      raw: "y".repeat(200),
    });
    const search = createServerSearch({ maxIndexBytes: 100 });
    const parse = vi.spyOn(JSON, "parse");

    await expect(search(source, "marker", 8)).resolves.toEqual([]);

    expect(parse).not.toHaveBeenCalled();
    expect(source.getSearchIndex).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: "docs_search_index_too_large",
      bytes: 200,
      limitBytes: 100,
    });
    parse.mockRestore();
    warn.mockRestore();
  });

  test("skips reading a published version already known to be too large", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const site = createScopedSource(
      "site:big:version",
      artifactWith("version-big", "/big", "Large marker")
    );
    const search = createServerSearch({ maxIndexBytes: 10 });

    await search(site, "marker", 8);
    await expect(search(site, "marker", 8)).resolves.toEqual([]);

    expect(site.getCompiledSearchIndex).toHaveBeenCalledTimes(1);
    expect(search.tooLarge.size).toBe(1);
    warn.mockRestore();
  });

  test("keeps reading a too-large host scope, which can move to a smaller version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = createScopedSource(
      "host:docs.example.com",
      artifactWith("version-big", "/big", "Large marker")
    );
    const search = createServerSearch({ maxIndexBytes: 10 });

    await search(host, "marker", 8);
    await search(host, "marker", 8);

    expect(host.getCompiledSearchIndex).toHaveBeenCalledTimes(2);
    expect(search.tooLarge.size).toBe(0);
    warn.mockRestore();
  });
});

describe("createSearchEngineCache", () => {
  test("replacing a key does not count its bytes twice", () => {
    const cache = createSearchEngineCache(100);
    const engine = createSearchEngine(sourceArtifact);
    cache.remember("a", engine, 40);
    cache.remember("a", engine, 50);
    expect(cache.totalBytes).toBe(50);
    expect(cache.size).toBe(1);
  });
});

function artifactWith(contentVersion: string, slug: string, text: string) {
  return runtimeSearchArtifactSchema.parse({
    schemaVersion: 1,
    contentVersion,
    documents: [
      {
        id: slug,
        slug,
        title: text,
        description: "",
        breadcrumb: [],
        section: "default",
        headings: [],
        keywords: [],
        content: text,
        lines: [{ text }],
      },
    ],
  });
}

function compiledBytes(artifact: ReturnType<typeof artifactWith>): number {
  return utf8ByteLength(JSON.stringify(compileSearchArtifact(artifact)));
}

function createScopedSource(
  cacheScope: string,
  artifact: ReturnType<typeof artifactWith>
): DoxaDocsRuntimeSource {
  const compiled = JSON.stringify(compileSearchArtifact(artifact));
  return {
    ...createRuntimeSource({ compiled, raw: null }),
    cacheScope,
  };
}
