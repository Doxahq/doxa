import {
  emptyPageDependencyState,
  type StagedRuntimePage,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  buildPageCacheDescriptor,
  createR2GenerationPageCache,
  pageCacheKey,
  pageDependencyDigest,
  pageDependencyPaths,
  preparePageBatchCacheContexts,
  runPageBatchWithCache,
  structureSourceEvidenceByPageId,
  type GenerationPageCache,
  type PageBatchCacheContext,
  type PageCacheEntry,
  type PageCacheKeyInput,
} from "../src/generation-page-cache";
import type {
  GenerationPageCheckpointStore,
} from "../src/generation-page-checkpoints";

const baseKeyInput: PageCacheKeyInput = {
  siteId: "site-1",
  pageId: "overview",
  pageInputHash: "a".repeat(64),
  dependencyDigest: "b".repeat(64),
  routeRegistryHash: "e".repeat(64),
  documentationPolicyVersion: "public-v1",
  instructionsFingerprint: "none",
  editBaseContentHash: null,
  writingContract: "writing-v1:model-a:handoff-v1",
};

describe("generation page cache keys", () => {
  test("changes when any scoped input changes", async () => {
    const baseline = await pageCacheKey(baseKeyInput);
    const changes: PageCacheKeyInput[] = [
      { ...baseKeyInput, siteId: "site-2" },
      { ...baseKeyInput, pageId: "quickstart" },
      { ...baseKeyInput, pageInputHash: "d".repeat(64) },
      { ...baseKeyInput, dependencyDigest: "e".repeat(64) },
      { ...baseKeyInput, routeRegistryHash: "2".repeat(64) },
      { ...baseKeyInput, documentationPolicyVersion: "public-v2" },
      { ...baseKeyInput, instructionsFingerprint: "f".repeat(64) },
      { ...baseKeyInput, editBaseContentHash: "c".repeat(64) },
      { ...baseKeyInput, writingContract: "writing-v1:model-b:handoff-v1" },
    ];

    expect(await pageCacheKey(baseKeyInput)).toBe(baseline);
    expect(baseline).toMatch(/^cache\/pages\/[0-9a-f]{64}\.json$/);
    for (const changed of changes) {
      expect(await pageCacheKey(changed)).not.toBe(baseline);
    }
  });

  test("isolates identical repository content by site", async () => {
    expect(await pageCacheKey(baseKeyInput)).not.toBe(
      await pageCacheKey({ ...baseKeyInput, siteId: "fork-site" }),
    );
  });

  test("keeps the cross-model tier stable while exact tiers differ", async () => {
    const exactA = await pageCacheKey({
      ...baseKeyInput,
      writingContract: "writing-v1:model-a:handoff-v1",
    });
    const exactB = await pageCacheKey({
      ...baseKeyInput,
      writingContract: "writing-v1:model-b:handoff-v1",
    });
    const crossA = await pageCacheKey({
      ...baseKeyInput,
      writingContract: "writing-v1:handoff-v1",
    });
    const crossB = await pageCacheKey({
      ...baseKeyInput,
      writingContract: "writing-v1:handoff-v1",
    });

    expect(exactA).not.toBe(exactB);
    expect(crossA).toBe(crossB);
  });

  test("misses when a sibling route changes and all page inputs remain stable", async () => {
    expect(await pageCacheKey({
      ...baseKeyInput,
      routeRegistryHash: "1".repeat(64),
    })).not.toBe(await pageCacheKey({
      ...baseKeyInput,
      routeRegistryHash: "2".repeat(64),
    }));
  });

  test("hits when analysis context and canonical routes are unchanged", async () => {
    const key = {
      ...baseKeyInput,
      routeRegistryHash: "1".repeat(64),
    };

    expect(await pageCacheKey(key)).toBe(await pageCacheKey({ ...key }));
  });
});

describe("page dependency digest", () => {
  test("is order independent and changes with file content", async () => {
    const sourceFiles = new Map([
      ["src/a.ts", "a".repeat(64)],
      ["src/b.ts", "b".repeat(64)],
    ]);
    const forward = await pageDependencyDigest({
      paths: ["src/a.ts", "src/b.ts", "src/a.ts"],
      sourceFiles,
    });
    const reverse = await pageDependencyDigest({
      paths: ["src/b.ts", "src/a.ts"],
      sourceFiles,
    });
    const changed = await pageDependencyDigest({
      paths: ["src/a.ts", "src/b.ts"],
      sourceFiles: new Map([
        ["src/a.ts", "a".repeat(64)],
        ["src/b.ts", "c".repeat(64)],
      ]),
    });

    expect(forward).toBe(reverse);
    expect(changed).not.toBe(forward);
  });

  test("distinguishes a missing file from an empty file", async () => {
    const missing = await pageDependencyDigest({
      paths: ["src/missing.ts"],
      sourceFiles: new Map(),
    });
    const empty = await pageDependencyDigest({
      paths: ["src/missing.ts"],
      sourceFiles: new Map([
        ["src/missing.ts", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ]),
    });

    expect(missing).not.toBe(empty);
  });

  test("combines declared and prior read dependencies deterministically", () => {
    expect(pageDependencyPaths({
      declaredSourceEvidence: ["src/b.ts", "src/a.ts"],
      baselineDependencies: {
        ...emptyPageDependencyState(),
        sourceFilesRead: ["src/c.ts", "src/a.ts"],
        sourceEvidenceFiles: ["src/d.ts"],
      },
    })).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
  });
});

describe("structure source evidence", () => {
  test("maps every flat page to its own declared evidence", () => {
    const evidence = structureSourceEvidenceByPageId(JSON.stringify({
      sections: [{
        pages: [
          { id: "guide", sourceEvidence: [{ path: "src/guide.ts" }] },
          { id: "guide/specific", sourceEvidence: [{ path: "src/specific.ts" }] },
          { id: "guide/explicit-empty", sourceEvidence: [] },
        ],
      }],
    }));

    expect(evidence.get("guide")).toEqual(["src/guide.ts"]);
    expect(evidence.get("guide/specific")).toEqual(["src/specific.ts"]);
    expect(evidence.get("guide/explicit-empty")).toEqual([]);
  });

  test("rejects a checkpoint that still contains child pages", () => {
    expect(() => structureSourceEvidenceByPageId(JSON.stringify({
      sections: [{ pages: [{ id: "guide", subPages: [{ id: "child" }] }] }],
    }))).toThrow("Structure checkpoint contains an invalid page.");
  });
});

describe("R2 generation page cache", () => {
  test("returns only present schema-valid entries", async () => {
    const bucket = new MemoryBucket();
    const cache = createR2GenerationPageCache(bucket);
    await bucket.put("cache/pages/corrupt.json", "{\"page\":");
    await bucket.put("cache/pages/invalid.json", JSON.stringify({
      page: { id: "missing-fields" },
      writerModel: "model-a",
      writingFingerprint: "fingerprint-a",
      createdAt: "2026-07-30T00:00:00.000Z",
    }));
    await cache.putMany([
      { key: "cache/pages/valid.json", entry: cacheEntry() },
    ]);

    await expect(cache.getMany([
      "cache/pages/missing.json",
      "cache/pages/corrupt.json",
      "cache/pages/invalid.json",
      "cache/pages/valid.json",
    ])).resolves.toEqual(new Map([
      ["cache/pages/valid.json", cacheEntry()],
    ]));
  });

  test("keeps the open issues of a cached page, so a cache hit still reports them", async () => {
    const bucket = new MemoryBucket();
    const cache = createR2GenerationPageCache(bucket);
    const withIssues: PageCacheEntry = {
      ...cacheEntry(),
      page: {
        ...page("overview"),
        openIssues: [{ check: "instructionTerminology", message: 'Say "repository", not "repo".', instructions: true }],
      },
    };

    await cache.putMany([{ key: "cache/pages/issues.json", entry: withIssues }]);
    const read = await cache.getMany(["cache/pages/issues.json"]);

    expect(read.get("cache/pages/issues.json")?.page.openIssues).toEqual(withIssues.page.openIssues);
  });

  test("writes valid JSON with the cache content type idempotently", async () => {
    const bucket = new MemoryBucket();
    const cache = createR2GenerationPageCache(bucket);
    const entry = cacheEntry();

    await cache.putMany([
      { key: "cache/pages/page.json", entry },
      { key: "cache/pages/page.json", entry },
    ]);

    expect(bucket.objects.size).toBe(1);
    expect(bucket.contentTypes).toEqual([
      "application/json; charset=utf-8",
      "application/json; charset=utf-8",
    ]);
    expect(JSON.parse(bucket.objects.get("cache/pages/page.json") ?? ""))
      .toEqual(entry);
  });
});

describe("cached page batches", () => {
  test("builds shared cache state once and narrows descriptors for three batches", async () => {
    const cache = createR2GenerationPageCache(new MemoryBucket());
    const descriptors = await Promise.all([
      descriptorFor("page-1"),
      descriptorFor("page-2"),
      descriptorFor("page-3"),
    ]);
    let reusableStateReads = 0;

    const contexts = await preparePageBatchCacheContexts({
      batches: [["page-1"], ["page-2"], ["page-3"]],
      build: async (pageIds) => {
        reusableStateReads += 1;
        expect(pageIds).toEqual(["page-1", "page-2", "page-3"]);
        return cacheContext(cache, descriptors);
      },
    });

    expect(reusableStateReads).toBe(1);
    expect(contexts.map((context) => [
      ...context?.descriptors.keys() ?? [],
    ])).toEqual([
      ["page-1"],
      ["page-2"],
      ["page-3"],
    ]);
  });

  test("uses exact hits without calling the writer", async () => {
    const bucket = new MemoryBucket();
    const cache = createR2GenerationPageCache(bucket);
    const descriptor = await descriptorFor("overview");
    await cache.putMany([{
      key: descriptor.exactKey,
      entry: cacheEntry(),
    }]);
    const store = new MemoryCheckpointStore();
    let writerCalls = 0;

    const result = await runPageBatchWithCache({
      pageIds: ["overview"],
      store,
      cacheContext: cacheContext(cache, [descriptor]),
      generate: async () => {
        writerCalls += 1;
        return { pages: [], failedPages: [] };
      },
    });

    expect(writerCalls).toBe(0);
    expect(await store.read("overview")).toEqual(page("overview"));
    expect(result).toEqual({
      keys: ["checkpoints/overview.json"],
      failedPages: [],
      exactHits: 1,
      crossModelHits: 0,
      generated: 0,
    });
  });

  test("checks cross-model cache only after exact misses and writes only fresh pages", async () => {
    const bucket = new MemoryBucket();
    const cache = createR2GenerationPageCache(bucket);
    const exact = await descriptorFor("exact");
    const cross = await descriptorFor("cross");
    const fresh = await descriptorFor("fresh");
    await cache.putMany([
      {
        key: exact.exactKey,
        entry: { ...cacheEntry("exact"), writerModel: "model-current" },
      },
      {
        key: cross.crossModelKey,
        entry: { ...cacheEntry("cross"), writerModel: "model-previous" },
      },
    ]);
    bucket.writtenKeys.length = 0;
    const crossHits: string[] = [];
    const pendingCalls: string[][] = [];
    const store = new MemoryCheckpointStore();

    const result = await runPageBatchWithCache({
      pageIds: ["exact", "cross", "fresh"],
      store,
      cacheContext: {
        ...cacheContext(cache, [exact, cross, fresh]),
        allowCrossModel: true,
        onCrossModelHit: async (pageId) => {
          crossHits.push(pageId);
        },
      },
      generate: async (pendingPageIds) => {
        pendingCalls.push([...pendingPageIds]);
        return { pages: pendingPageIds.map((pageId) => page(pageId)), failedPages: [] };
      },
    });

    expect(pendingCalls).toEqual([["fresh"]]);
    expect(crossHits).toEqual(["cross"]);
    expect(bucket.writtenKeys).toEqual([
      fresh.exactKey,
      fresh.crossModelKey,
    ]);
    expect(await store.read("exact")).not.toBeNull();
    expect(await store.read("cross")).not.toBeNull();
    expect(await store.read("fresh")).not.toBeNull();
    expect(result).toMatchObject({
      exactHits: 1,
      crossModelHits: 1,
      generated: 1,
    });
  });

  test("generates a cross-model hit when cross-model reuse is disabled", async () => {
    const bucket = new MemoryBucket();
    const cache = createR2GenerationPageCache(bucket);
    const descriptor = await descriptorFor("overview");
    await cache.putMany([{
      key: descriptor.crossModelKey,
      entry: { ...cacheEntry(), writerModel: "model-previous" },
    }]);
    const generated: string[][] = [];

    const result = await runPageBatchWithCache({
      pageIds: ["overview"],
      store: new MemoryCheckpointStore(),
      cacheContext: cacheContext(cache, [descriptor]),
      generate: async (pageIds) => {
        generated.push([...pageIds]);
        return { pages: pageIds.map((pageId) => page(pageId)), failedPages: [] };
      },
    });

    expect(generated).toEqual([["overview"]]);
    expect(result).toMatchObject({
      exactHits: 0,
      crossModelHits: 0,
      generated: 1,
    });
  });

  test("regenerates when dependency content changes but page input does not", async () => {
    const bucket = new MemoryBucket();
    const cache = createR2GenerationPageCache(bucket);
    const stale = await descriptorFor(
      "overview",
      "b".repeat(64),
    );
    const current = await descriptorFor(
      "overview",
      "c".repeat(64),
    );
    await cache.putMany([{
      key: stale.exactKey,
      entry: cacheEntry(),
    }]);
    const generated: string[][] = [];

    const result = await runPageBatchWithCache({
      pageIds: ["overview"],
      store: new MemoryCheckpointStore(),
      cacheContext: cacheContext(cache, [current]),
      generate: async (pageIds) => {
        generated.push([...pageIds]);
        return { pages: pageIds.map((pageId) => page(pageId)), failedPages: [] };
      },
    });

    expect(stale.pageInputHash).toBe(current.pageInputHash);
    expect(stale.dependencyDigest).not.toBe(current.dependencyDigest);
    expect(stale.exactKey).not.toBe(current.exactKey);
    expect(generated).toEqual([["overview"]]);
    expect(result.generated).toBe(1);
  });

  test("writes a page again when only the project instructions changed", async () => {
    const cache = createR2GenerationPageCache(new MemoryBucket());
    const published = await descriptorFor("overview", "b".repeat(64), {
      instructionsFingerprint: "instructions-old",
    });
    const current = await descriptorFor("overview", "b".repeat(64), {
      instructionsFingerprint: "instructions-new",
    });
    await cache.putMany([{ key: published.exactKey, entry: cacheEntry() }]);
    const generated: string[][] = [];

    const result = await runPageBatchWithCache({
      pageIds: ["overview"],
      store: new MemoryCheckpointStore(),
      cacheContext: cacheContext(cache, [current]),
      generate: async (pageIds) => {
        generated.push([...pageIds]);
        return { pages: pageIds.map((pageId) => page(pageId)), failedPages: [] };
      },
    });

    expect(published.dependencyDigest).toBe(current.dependencyDigest);
    expect(published.exactKey).not.toBe(current.exactKey);
    expect(generated).toEqual([["overview"]]);
    expect(result.exactHits).toBe(0);
  });

  test("serves an edited page only for the same live text it started from", async () => {
    const cache = createR2GenerationPageCache(new MemoryBucket());
    const editedBefore = await descriptorFor("overview", "b".repeat(64), {
      editBaseContentHash: "1".repeat(64),
    });
    const sameLiveText = await descriptorFor("overview", "b".repeat(64), {
      editBaseContentHash: "1".repeat(64),
    });
    const personChangedLiveText = await descriptorFor("overview", "b".repeat(64), {
      editBaseContentHash: "2".repeat(64),
    });
    const freshWrite = await descriptorFor("overview", "b".repeat(64));
    await cache.putMany([{ key: editedBefore.exactKey, entry: cacheEntry() }]);

    const runWith = async (descriptor: Awaited<ReturnType<typeof descriptorFor>>) => {
      const generated: string[][] = [];
      const result = await runPageBatchWithCache({
        pageIds: ["overview"],
        store: new MemoryCheckpointStore(),
        cacheContext: { ...cacheContext(cache, [descriptor]), allowCrossModel: true },
        generate: async (pageIds) => {
          generated.push([...pageIds]);
          return { pages: pageIds.map((pageId) => page(pageId)), failedPages: [] };
        },
      });
      return { generated, result };
    };

    expect((await runWith(sameLiveText)).result.exactHits).toBe(1);
    expect((await runWith(personChangedLiveText)).generated).toEqual([["overview"]]);
    expect(freshWrite.exactKey).not.toBe(editedBefore.exactKey);
  });

  test("caches a page when it checkpoints, before the batch ends", async () => {
    const bucket = new MemoryBucket();
    const cache = createR2GenerationPageCache(bucket);
    const first = await descriptorFor("overview");
    const second = await descriptorFor("quickstart");

    await expect(runPageBatchWithCache({
      pageIds: ["overview", "quickstart"],
      store: new MemoryCheckpointStore(),
      cacheContext: cacheContext(cache, [first, second]),
      generate: async (_pageIds, checkpoint) => {
        await checkpoint(page("overview"));
        throw new Error("internal error; reference = abc");
      },
    })).rejects.toThrow("internal error");

    const cached = await cache.getMany([first.exactKey, second.exactKey]);
    expect([...cached.keys()]).toEqual([first.exactKey]);
  });

  test("preserves the old resumable behavior without a cache context", async () => {
    const generated: string[][] = [];

    const result = await runPageBatchWithCache({
      pageIds: ["overview"],
      store: new MemoryCheckpointStore(),
      generate: async (pageIds) => {
        generated.push([...pageIds]);
        return { pages: pageIds.map((pageId) => page(pageId)), failedPages: [] };
      },
    });

    expect(generated).toEqual([["overview"]]);
    expect(result).toMatchObject({
      exactHits: 0,
      crossModelHits: 0,
      generated: 1,
    });
  });
});

function cacheEntry(id = "overview"): PageCacheEntry {
  return {
    page: page(id),
    writerModel: "model-a",
    writingFingerprint: "fingerprint-a",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

function page(id: string): StagedRuntimePage {
  return {
    id,
    title: "Overview",
    route: "/overview",
    navigationPath: "default/overview.md",
    content: "# Overview\n",
    dependencies: emptyPageDependencyState(),
    contentHash: "d".repeat(64),
    pageInputHash: "a".repeat(64),
  };
}

class MemoryBucket {
  readonly objects = new Map<string, string>();
  readonly contentTypes: string[] = [];
  readonly writtenKeys: string[] = [];

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return { text: async () => value } as R2ObjectBody;
  }

  async put(key: string, value: string, options?: R2PutOptions) {
    this.objects.set(key, value);
    this.writtenKeys.push(key);
    const metadata = options?.httpMetadata;
    this.contentTypes.push(
      metadata && !(metadata instanceof Headers)
        ? metadata.contentType ?? ""
        : "",
    );
    return null;
  }
}

class MemoryCheckpointStore implements GenerationPageCheckpointStore {
  private readonly pages = new Map<string, StagedRuntimePage>();

  key(pageId: string): string {
    return `checkpoints/${pageId}.json`;
  }

  async read(pageId: string): Promise<StagedRuntimePage | null> {
    return this.pages.get(pageId) ?? null;
  }

  async write(pageValue: StagedRuntimePage): Promise<string> {
    this.pages.set(pageValue.id, pageValue);
    return this.key(pageValue.id);
  }
}

async function descriptorFor(
  pageId: string,
  sourceContentHash = "b".repeat(64),
  options: { instructionsFingerprint?: string; editBaseContentHash?: string } = {},
) {
  return buildPageCacheDescriptor({
    key: {
      siteId: "site-1",
      pageId,
      pageInputHash: "a".repeat(64),
      routeRegistryHash: "e".repeat(64),
      documentationPolicyVersion: "public-v1",
      instructionsFingerprint: options.instructionsFingerprint ?? "none",
      editBaseContentHash: options.editBaseContentHash ?? null,
    },
    paths: ["src/index.ts"],
    sourceFiles: new Map([["src/index.ts", sourceContentHash]]),
    exactWritingContract: "writing-v1:model-current:handoff-v1",
    crossModelWritingContract: "writing-v1:handoff-v1",
  });
}

function cacheContext(
  cache: GenerationPageCache,
  descriptors: Awaited<ReturnType<typeof descriptorFor>>[],
): PageBatchCacheContext {
  return {
    cache,
    descriptors: new Map(
      descriptors.map((descriptor) => [descriptor.pageId, descriptor]),
    ),
    allowCrossModel: false,
    writerModel: "model-current",
    writingFingerprint: "writing-v1:model-current:handoff-v1",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}
