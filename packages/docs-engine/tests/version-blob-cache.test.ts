import { describe, expect, test } from "vitest";
import {
  MemoryVersionByteCache,
  chainVersionByteCaches,
  createVersionTreeReader,
  sharedVersionBlobCache,
  siteBlobKey,
  writeVersionTree,
  type VersionByteCache,
  type VersionTreeObject,
  type VersionTreeStorage,
} from "../src/version-tree";

const siteId = "11111111-1111-4111-8111-111111111111";
const versionId = "33333333-3333-4333-8333-333333333333";
const prefix = `sites/${siteId}/versions/${versionId}`;
const MDX = "text/plain; charset=utf-8";

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
  const blobGets = () => gets.filter((key) => key.includes("/blobs/"));
  return { storage, objects, gets, blobGets };
}

function objectOf(bytes: Uint8Array): VersionTreeObject {
  return {
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
    size: bytes.byteLength,
  };
}

async function writeSite(storage: VersionTreeStorage, big = "") {
  return writeVersionTree(storage, {
    siteId,
    versionId,
    files: [
      { path: "source/index.mdx", content: "# Home\n", contentType: MDX },
      { path: "source/big/index.mdx", content: big || "# Big\n", contentType: MDX },
    ],
  });
}

describe("memory blob cache", () => {
  test("keeps blobs under the total size cap and drops the least recently used", () => {
    const cache = new MemoryVersionByteCache({ maxBytes: 10, maxEntryBytes: 6 });
    const bytes = (length: number) => new Uint8Array(length);

    cache.put("a", bytes(4));
    cache.put("b", bytes(4));
    expect(cache.get("a")).not.toBeNull();
    cache.put("c", bytes(4));

    // "b" was the least recently used blob, so it made room for "c".
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
    expect(cache.size).toBe(8);
  });

  test("never keeps a blob over the blob size limit", () => {
    const cache = new MemoryVersionByteCache({ maxBytes: 100, maxEntryBytes: 4 });

    cache.put("large", new Uint8Array(5));

    expect(cache.get("large")).toBeNull();
    expect(cache.size).toBe(0);
  });

  test("a second put of a key replaces it without counting it twice", () => {
    const cache = new MemoryVersionByteCache({ maxBytes: 100, maxEntryBytes: 10 });

    cache.put("a", new Uint8Array(4));
    cache.put("a", new Uint8Array(4));

    expect(cache.size).toBe(4);
  });

  test("the shared cache is one per storage binding", () => {
    const first = {};
    const second = {};

    expect(sharedVersionBlobCache(first)).toBe(sharedVersionBlobCache(first));
    expect(sharedVersionBlobCache(first)).not.toBe(sharedVersionBlobCache(second));
  });
});

describe("version tree reader with a blob cache", () => {
  test("a cache hit returns the same bytes and makes no blob read", async () => {
    const { storage, blobGets } = memoryStorage();
    await writeSite(storage);
    const blobCache = new MemoryVersionByteCache();
    const reader = createVersionTreeReader(storage, { blobCache });

    const first = await reader.get(`${prefix}/source/index.mdx`);
    const second = await reader.get(`${prefix}/source/index.mdx`);

    expect(await first?.text()).toBe("# Home\n");
    expect(await second?.text()).toBe("# Home\n");
    expect(second?.size).toBe(7);
    expect(second?.httpMetadata?.contentType).toBe(MDX);
    expect(blobGets()).toHaveLength(1);
  });

  test("a caller cannot change the cached bytes", async () => {
    const { storage } = memoryStorage();
    await writeSite(storage);
    const reader = createVersionTreeReader(storage, {
      blobCache: new MemoryVersionByteCache(),
    });

    const first = await reader.get(`${prefix}/source/index.mdx`);
    new Uint8Array(await first!.arrayBuffer()).fill(0);
    const second = await reader.get(`${prefix}/source/index.mdx`);

    expect(await second?.text()).toBe("# Home\n");
  });

  test("a missing blob is never kept, so the read fails closed every time", async () => {
    const { storage, objects, blobGets } = memoryStorage();
    const written = await writeSite(storage);
    const blobKey = siteBlobKey(
      siteId,
      written.tree.files["source/index.mdx"].sha256,
    );
    objects.delete(blobKey);
    const blobCache = new MemoryVersionByteCache();
    const reader = createVersionTreeReader(storage, { blobCache });

    await expect(reader.get(`${prefix}/source/index.mdx`)).rejects.toThrow(
      /missing/,
    );
    await expect(reader.get(`${prefix}/source/index.mdx`)).rejects.toThrow(
      /missing/,
    );
    expect(blobCache.get(blobKey)).toBeNull();
    expect(blobGets()).toEqual([blobKey, blobKey]);
  });

  test("a missing path still reads as null and is not kept", async () => {
    const { storage, blobGets } = memoryStorage();
    await writeSite(storage);
    const blobCache = new MemoryVersionByteCache();
    const reader = createVersionTreeReader(storage, { blobCache });

    expect(await reader.get(`${prefix}/source/missing/index.mdx`)).toBeNull();
    expect(blobCache.size).toBe(0);
    expect(blobGets()).toEqual([]);
  });

  test("a blob over the size limit goes to storage on every read", async () => {
    const { storage, blobGets } = memoryStorage();
    await writeSite(storage, "x".repeat(64));
    const blobCache = new MemoryVersionByteCache({ maxEntryBytes: 32 });
    const reader = createVersionTreeReader(storage, { blobCache });

    await reader.get(`${prefix}/source/big/index.mdx`);
    const again = await reader.get(`${prefix}/source/big/index.mdx`);

    expect(await again?.text()).toBe("x".repeat(64));
    expect(blobGets()).toHaveLength(2);
    expect(blobCache.size).toBe(0);
  });

  test("a failing cache does not fail the read", async () => {
    const { storage } = memoryStorage();
    await writeSite(storage);
    const broken: VersionByteCache = {
      maxEntryBytes: 1024,
      get: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
    };
    const reader = createVersionTreeReader(storage, { blobCache: broken });

    expect(await (await reader.get(`${prefix}/source/index.mdx`))?.text()).toBe(
      "# Home\n",
    );
  });

  test("a cached entry of the wrong size is ignored", async () => {
    const { storage, blobGets } = memoryStorage();
    const written = await writeSite(storage);
    const blobKey = siteBlobKey(
      siteId,
      written.tree.files["source/index.mdx"].sha256,
    );
    const blobCache = new MemoryVersionByteCache();
    blobCache.put(blobKey, new TextEncoder().encode("a damaged entry"));
    const reader = createVersionTreeReader(storage, { blobCache });

    expect(await (await reader.get(`${prefix}/source/index.mdx`))?.text()).toBe(
      "# Home\n",
    );
    expect(blobGets()).toEqual([blobKey]);
  });
});

describe("chained blob caches", () => {
  test("a hit in a later cache fills the earlier cache", async () => {
    const memory = new MemoryVersionByteCache();
    const edge = new MemoryVersionByteCache();
    const bytes = new TextEncoder().encode("blob");
    edge.put("key", bytes);
    const chain = chainVersionByteCaches(memory, edge);

    expect(await chain.get("key")).toEqual(bytes);
    expect(memory.get("key")).toEqual(bytes);
  });

  test("a put goes to each cache that accepts the size", async () => {
    const small = new MemoryVersionByteCache({ maxEntryBytes: 2 });
    const large = new MemoryVersionByteCache({ maxEntryBytes: 100 });
    const chain = chainVersionByteCaches(small, large);

    chain.put("key", new Uint8Array(10));

    expect(chain.maxEntryBytes).toBe(100);
    expect(small.get("key")).toBeNull();
    expect(large.get("key")).not.toBeNull();
  });

  test("a failing cache reads as a miss", async () => {
    const broken: VersionByteCache = {
      maxEntryBytes: 100,
      get: () => {
        throw new Error("down");
      },
      put: () => {
        throw new Error("down");
      },
    };
    const memory = new MemoryVersionByteCache();
    memory.put("key", new Uint8Array(3));
    const chain = chainVersionByteCaches(broken, memory);

    expect(await chain.get("key")).toHaveLength(3);
    expect(await chain.get("other")).toBeNull();
    expect(() => chain.put("key", new Uint8Array(1))).not.toThrow();
  });
});
