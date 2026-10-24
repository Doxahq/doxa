import type {
  StorageCollector,
  StorageGcEntry,
} from "@doxahq/contracts/storage-gc";
import { describe, expect, test, vi } from "vitest";

import { createDocsPrerenderRenderCollector } from "../../src/services/storage-gc/collectors/docs-prerender-render";
import {
  REFERENCED_PREVIEW_RECHECK_SECONDS,
  createDocsOrphanVersionPrefixCollector,
  createDocsPreviewVersionCollector,
} from "../../src/services/storage-gc/collectors/docs-version-prefix";
import { StorageGarbageCollector } from "../../src/services/storage-gc/runner";

describe("storage garbage collector", () => {
  test("deletes a resource that no longer serves production", async () => {
    const store = createStore([entry()]);
    const collect = vi.fn(async () => ({
      deletedObjects: 3,
      status: "complete" as const,
    }));

    const result = await new StorageGarbageCollector(store, [
      collector({ collect }),
    ]).run();

    expect(collect).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ collected: 1, deletedObjects: 3 });
    expect(store.prune).toHaveBeenCalledOnce();
    expect(store.markCollected).toHaveBeenCalledWith({
      entryId: "11111111-1111-4111-8111-111111111111",
      claimToken: "claim-token-0123456789",
      deletedObjects: 3,
    });
  });

  test("keeps a resource that the collector still reports as in use", async () => {
    const store = createStore([entry()]);
    const collect = vi.fn();

    const result = await new StorageGarbageCollector(store, [
      collector({
        collect,
        inspect: async () => ({ status: "retain", reason: "still_live" }),
      }),
    ]).run();

    expect(collect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retained: 1, deletedObjects: 0 });
    expect(store.markRetained).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "still_live" }),
    );
  });

  test("returns a retained entry to the work list when the collector asks for a recheck", async () => {
    const store = createStore([entry()]);

    const result = await new StorageGarbageCollector(store, [
      collector({
        inspect: async () => ({
          status: "retain",
          reason: "still_live",
          recheckAfterSeconds: 60,
        }),
      }),
    ]).run();

    expect(result).toMatchObject({ retained: 1 });
    expect(store.markRetained).not.toHaveBeenCalled();
    expect(store.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ delaySeconds: 60, deletedObjects: 0 }),
    );
  });

  test("collects only the named entries now, without pruning", async () => {
    const store = createStore([entry()]);
    const collect = vi.fn(async () => ({
      deletedObjects: 2,
      status: "complete" as const,
    }));

    const result = await new StorageGarbageCollector(store, [
      collector({ collect }),
    ]).collectNow(["11111111-1111-4111-8111-111111111111"]);

    expect(store.claim).toHaveBeenCalledWith([
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(result).toMatchObject({ collected: 1, deletedObjects: 2 });
    expect(store.prune).not.toHaveBeenCalled();
  });

  test("claims nothing when no entry is named", async () => {
    const store = createStore([entry()]);

    await new StorageGarbageCollector(store, [collector()]).collectNow([]);

    expect(store.claim).not.toHaveBeenCalled();
  });

  test("returns an entry to the work list when the deletion is incomplete", async () => {
    const store = createStore([entry()]);

    const result = await new StorageGarbageCollector(store, [
      collector({
        collect: async () => ({
          deletedObjects: 2_000,
          status: "incomplete" as const,
        }),
      }),
    ]).run();

    expect(result).toMatchObject({ incomplete: 1, deletedObjects: 2_000 });
    expect(store.reschedule).toHaveBeenCalledOnce();
    expect(store.markCollected).not.toHaveBeenCalled();
  });

  test("waits the requested delay before an incomplete entry runs again", async () => {
    const store = createStore([entry()]);

    await new StorageGarbageCollector(store, [
      collector({
        collect: async () => ({
          deletedObjects: 3,
          status: "incomplete" as const,
          recheckAfterSeconds: 3_600,
        }),
      }),
    ]).run();

    expect(store.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ deletedObjects: 3, delaySeconds: 3_600 }),
    );
  });

  test("records a failure without deleting further objects", async () => {
    const store = createStore([entry()]);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await new StorageGarbageCollector(store, [
      collector({
        collect: async () => {
          throw new Error("storage unavailable");
        },
      }),
    ]).run();

    expect(result).toMatchObject({ failed: 1, deletedObjects: 0 });
    expect(store.markFailed).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("storage_gc_entry_failed"),
    );
    errorLog.mockRestore();
  });

  test("waits instead of failing when a target has no collector here", async () => {
    const store = createStore([entry({ target: "future_feature" })]);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await new StorageGarbageCollector(store, []).run();

    expect(result).toMatchObject({ skipped: 1, failed: 0 });
    expect(store.reschedule).toHaveBeenCalledOnce();
    expect(store.markFailed).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  test("rejects a resource that does not match the collector contract", async () => {
    const store = createStore([entry({ resource: { siteId: "site-1" } })]);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await new StorageGarbageCollector(store, [
      createDocsPrerenderRenderCollector({
        store: { isRenderCurrent: async () => false },
        deleter: {
          collectRender: vi.fn(),
        },
      }) as StorageCollector,
    ]).run();

    expect(result).toMatchObject({ failed: 1 });
    errorLog.mockRestore();
  });
});

describe("pre-render render collector", () => {
  test("keeps a render that a production hostname still resolves to", async () => {
    const collectRender = vi.fn();
    const subject = createDocsPrerenderRenderCollector({
      store: { isRenderCurrent: async () => true },
      deleter: { collectRender },
    });

    await expect(
      subject.inspect({ siteId: "site-1", renderId: "a".repeat(64) }),
    ).resolves.toEqual({
      status: "retain",
      reason: "render_serves_production",
    });
    expect(collectRender).not.toHaveBeenCalled();
  });

  test("sends the site and render identity only to the delete RPC", async () => {
    const collectRender = vi.fn(async () => ({
      deletedObjects: 2,
      status: "complete" as const,
    }));
    const subject = createDocsPrerenderRenderCollector({
      store: { isRenderCurrent: async () => false },
      deleter: { collectRender },
    });

    await subject.collect({
      siteId: "site-1",
      renderId: "a".repeat(64),
      hostname: "docs.example.com",
    });

    expect(collectRender).toHaveBeenCalledWith({
      siteId: "site-1",
      renderId: "a".repeat(64),
    });
  });
});

describe("docs version prefix collectors", () => {
  const siteId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";
  const resource = { siteId, versionId };

  test("checks a referenced preview version again later", async () => {
    const removeMany = vi.fn();
    const collector = createDocsPreviewVersionCollector({
      versions: { findPreviewVersionRetention: async () => "referenced" },
      content: { listKeys: async () => [], removeMany },
    });

    await expect(collector.inspect(resource)).resolves.toEqual({
      status: "retain",
      reason: "version_is_referenced",
      recheckAfterSeconds: REFERENCED_PREVIEW_RECHECK_SECONDS,
    });
    expect(removeMany).not.toHaveBeenCalled();
  });

  test.each(["shared_prefix", "not_preview"] as const)(
    "never deletes a folder when its retention is %s",
    async (retention) => {
      // A promoted generation serves the folder of its source preview, so
      // the folder of that preview must stay while production uses it.
      const listKeys = vi.fn(async () => []);
      const collector = createDocsPreviewVersionCollector({
        versions: { findPreviewVersionRetention: async () => retention },
        content: { listKeys, removeMany: vi.fn() },
      });

      await expect(collector.inspect(resource)).resolves.toEqual({
        status: "retain",
        reason: retention,
      });
      expect(listKeys).not.toHaveBeenCalled();
    },
  );

  test("deletes only keys under the validated version prefix", async () => {
    const prefix = `sites/${siteId}/versions/${versionId}/`;
    const keys = [`${prefix}manifest.json`, `${prefix}source/index.mdx`];
    const listKeys = vi.fn(async () => keys);
    const removeMany = vi.fn(async (_keys: readonly string[]) => undefined);
    const collector = createDocsPreviewVersionCollector({
      versions: { findPreviewVersionRetention: async () => null },
      content: { listKeys, removeMany },
    });

    await expect(collector.collect(resource)).resolves.toEqual({
      deletedObjects: 2,
      status: "complete",
    });
    expect(listKeys).toHaveBeenCalledWith(prefix);
    expect(removeMany).toHaveBeenCalledWith(keys);
  });

  test("deletes a large prefix in bounded batches", async () => {
    const prefix = `sites/${siteId}/versions/${versionId}/`;
    const keys = Array.from(
      { length: 501 },
      (_, index) => `${prefix}source/page-${index}.mdx`,
    );
    const removeMany = vi.fn(async (_keys: readonly string[]) => undefined);
    const collector = createDocsPreviewVersionCollector({
      versions: { findPreviewVersionRetention: async () => null },
      content: { listKeys: async () => keys, removeMany },
    });

    await collector.collect(resource);

    expect(removeMany).toHaveBeenCalledTimes(2);
    expect(removeMany.mock.calls[0]?.[0]).toHaveLength(500);
    expect(removeMany.mock.calls[1]?.[0]).toHaveLength(1);
  });

  test("asks for a blob sweep after a complete folder deletion only", async () => {
    const prefix = `sites/${siteId}/versions/${versionId}/`;
    const onCollected = vi.fn(async () => undefined);
    const small = createDocsOrphanVersionPrefixCollector({
      versions: { isVersionPrefixInUse: async () => false },
      content: {
        listKeys: async () => [`${prefix}tree.json`],
        removeMany: vi.fn(async () => undefined),
      },
      onCollected,
    });
    await small.collect(resource);
    expect(onCollected).toHaveBeenCalledWith(resource);

    onCollected.mockClear();
    const large = createDocsOrphanVersionPrefixCollector({
      versions: { isVersionPrefixInUse: async () => false },
      content: {
        listKeys: async () =>
          Array.from({ length: 2_001 }, (_, index) => `${prefix}f-${index}`),
        removeMany: vi.fn(async () => undefined),
      },
      onCollected,
    });
    await expect(large.collect(resource)).resolves.toMatchObject({
      status: "incomplete",
    });
    expect(onCollected).not.toHaveBeenCalled();
  });

  test("keeps an orphan prefix when a version row uses it", async () => {
    const collector = createDocsOrphanVersionPrefixCollector({
      versions: { isVersionPrefixInUse: async () => true },
      content: { listKeys: async () => [], removeMany: vi.fn() },
    });

    await expect(collector.inspect(resource)).resolves.toEqual({
      status: "retain",
      reason: "version_row_exists",
    });
  });

  test("rejects a raw storage key as a version resource", () => {
    const collector = createDocsOrphanVersionPrefixCollector({
      versions: { isVersionPrefixInUse: async () => false },
      content: { listKeys: async () => [], removeMany: vi.fn() },
    });

    expect(() =>
      collector.parse({
        siteId,
        versionId,
        key: "sites/another-site/versions/another-version",
      }),
    ).toThrow();
  });
});

function entry(overrides: Partial<StorageGcEntry> = {}): StorageGcEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    target: "docs_prerender_render",
    resourceKey: `site-1/${"a".repeat(64)}`,
    resource: { siteId: "site-1", renderId: "a".repeat(64) },
    reason: "publication_changed",
    claimToken: "claim-token-0123456789",
    attempt: 1,
    ...overrides,
  };
}

function collector(
  overrides: Partial<StorageCollector> = {},
): StorageCollector {
  return {
    target: "docs_prerender_render",
    parse: (resource) => resource,
    inspect: async () => ({ status: "collect" }),
    collect: async () => ({ deletedObjects: 0, status: "complete" }),
    ...overrides,
  };
}

function createStore(entries: StorageGcEntry[]) {
  return {
    claim: vi.fn(async (_entryIds?: readonly string[]) => entries),
    markCollected: vi.fn(async () => undefined),
    markRetained: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    prune: vi.fn(async () => 0),
    readHealth: vi.fn(async () => ({
      pendingCount: 0,
      failedCount: 0,
      exhaustedCount: 0,
      oldestEntryAgeSeconds: 0,
    })),
  };
}
