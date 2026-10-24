import { describe, expect, test, vi } from "vitest";
import {
  createEdgeByteCache,
  workerVersionCaches,
  type EdgeCache,
} from "../src/version-edge-cache";
import {
  MemoryVersionByteCache,
  VersionTreeCache,
  createVersionTreeReader,
  versionTreeKey,
  writeVersionTree,
  type VersionTreeObject,
  type VersionTreeStorage,
} from "../src/version-tree";

const siteId = "11111111-1111-4111-8111-111111111111";
const versionId = "33333333-3333-4333-8333-333333333333";
const prefix = `sites/${siteId}/versions/${versionId}`;
const MDX = "text/plain; charset=utf-8";

/** A Workers `Cache` over a map, keyed by URL. */
function memoryEdgeCache() {
  const entries = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  const cache: EdgeCache = {
    match: vi.fn(async (request: RequestInfo | URL) => {
      const entry = entries.get(String(request));
      return entry ? new Response(entry.bytes.slice()) : undefined;
    }),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      entries.set(String(request), {
        bytes: new Uint8Array(await response.arrayBuffer()),
        headers: response.headers,
      });
    }),
  };
  return { cache, entries };
}

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const gets: string[] = [];
  const storage: VersionTreeStorage = {
    async get(key) {
      gets.push(key);
      const bytes = objects.get(key);
      return bytes ? objectOf(bytes) : null;
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async put(key, value) {
      objects.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
    },
  };
  return { storage, objects, gets };
}

function objectOf(bytes: Uint8Array): VersionTreeObject {
  return {
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
    size: bytes.byteLength,
  };
}

async function writeSite(storage: VersionTreeStorage) {
  return writeVersionTree(storage, {
    siteId,
    versionId,
    files: [{ path: "source/index.mdx", content: "# Home\n", contentType: MDX }],
  });
}

/** A reader with the memory of a new isolate and the given tree tier. */
function newIsolateReader(
  storage: VersionTreeStorage,
  treeBytesCache: MemoryVersionByteCache,
) {
  return createVersionTreeReader(storage, {
    cache: new VersionTreeCache(),
    treeBytesCache,
  });
}

describe("the edge byte cache", () => {
  test("keeps an entry under a URL of its tier, with its max age", async () => {
    const { cache, entries } = memoryEdgeCache();
    const waits: Promise<unknown>[] = [];
    const edge = createEdgeByteCache(cache, {
      tier: "trees",
      maxEntryBytes: 1024,
      maxAgeSeconds: 60,
      waitUntil: (promise) => waits.push(promise),
    });

    expect(await edge.get("sites/a/versions/b/tree.json")).toBeNull();
    await edge.put("sites/a/versions/b/tree.json", new TextEncoder().encode("{}"));

    const url = "https://docs-version-cache.internal/trees/sites/a/versions/b/tree.json";
    expect([...entries.keys()]).toEqual([url]);
    expect(entries.get(url)?.headers.get("cache-control")).toBe(
      "public, max-age=60, immutable",
    );
    expect(new TextDecoder().decode((await edge.get("sites/a/versions/b/tree.json"))!)).toBe(
      "{}",
    );
    expect(waits).toHaveLength(1);
  });
});

describe("the Worker version caches", () => {
  test("stay in memory when there is no edge cache", () => {
    const storage = {};
    const caches = workerVersionCaches(storage);

    expect(caches.treeBytesCache).toBeUndefined();
    expect(caches.blobCache).toBeInstanceOf(MemoryVersionByteCache);
    expect(workerVersionCaches(storage).cache).toBe(caches.cache);
  });

  test("can keep blobs out of memory", async () => {
    const { cache } = memoryEdgeCache();

    expect(workerVersionCaches({}, { memoryBlobs: false }).blobCache).toBeUndefined();
    expect(
      workerVersionCaches({}, { edgeCache: cache, memoryBlobs: false }).blobCache,
    ).not.toBeInstanceOf(MemoryVersionByteCache);
  });

  test("put trees and blobs in separate edge tiers", async () => {
    const { storage } = memoryStorage();
    await writeSite(storage);
    const { cache, entries } = memoryEdgeCache();
    const waits: Promise<unknown>[] = [];
    const reader = createVersionTreeReader(
      storage,
      workerVersionCaches(storage, {
        edgeCache: cache,
        waitUntil: (promise) => waits.push(promise),
      }),
    );

    await reader.get(`${prefix}/source/index.mdx`);
    await Promise.all(waits);

    const tiers = [...entries.keys()].map((url) => new URL(url).pathname.split("/")[1]);
    expect(tiers.sort()).toEqual(["blobs", "trees"]);
  });
});

describe("the tree byte cache of the reader", () => {
  test("a new isolate reads a cached tree without a storage call", async () => {
    const { storage, gets } = memoryStorage();
    await writeSite(storage);
    const trees = new MemoryVersionByteCache();

    const first = await newIsolateReader(storage, trees).readTree(prefix);
    gets.length = 0;
    const second = await newIsolateReader(storage, trees).readTree(prefix);

    expect(second).toEqual(first);
    expect(gets).toEqual([]);
  });

  test("never keeps a missing tree", async () => {
    const { storage } = memoryStorage();
    const trees = new MemoryVersionByteCache();

    expect(await newIsolateReader(storage, trees).readTree(prefix)).toBeNull();
    expect(trees.size).toBe(0);
  });

  test("reads storage when a cached tree is damaged", async () => {
    const { storage, gets } = memoryStorage();
    const written = await writeSite(storage);
    const trees = new MemoryVersionByteCache();
    trees.put(versionTreeKey(prefix), new TextEncoder().encode("{not json"));

    expect(await newIsolateReader(storage, trees).readTree(prefix)).toEqual(
      written.tree,
    );
    expect(gets).toEqual([versionTreeKey(prefix)]);
  });

  test("does not keep a tree that is larger than the tier allows", async () => {
    const { storage } = memoryStorage();
    await writeSite(storage);
    const trees = new MemoryVersionByteCache({ maxEntryBytes: 16 });

    await newIsolateReader(storage, trees).readTree(prefix);

    expect(trees.size).toBe(0);
  });

  test("an invalid tree in storage still fails closed and is not kept", async () => {
    const { storage } = memoryStorage();
    await storage.put(versionTreeKey(prefix), "{not json");
    const trees = new MemoryVersionByteCache();

    await expect(newIsolateReader(storage, trees).readTree(prefix)).rejects.toThrow();
    expect(trees.size).toBe(0);
  });
});
