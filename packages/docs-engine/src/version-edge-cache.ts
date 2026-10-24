import {
  chainVersionByteCaches,
  sharedVersionBlobCache,
  sharedVersionTreeCache,
  type VersionByteCache,
  type VersionTreeReaderOptions,
} from "./version-tree";

/** The part of a Workers `Cache` that the edge tiers use. */
export type EdgeCache = Pick<Cache, "match" | "put">;

/** Keeps work alive after the response, such as a cache fill. */
export type WaitUntil = (promise: Promise<unknown>) => void;

export interface EdgeByteCacheOptions {
  /** Keeps the tiers apart in the cache URL, for example `blobs`. */
  readonly tier: string;
  readonly maxEntryBytes: number;
  readonly maxAgeSeconds: number;
  /**
   * Without it, a fill can stop when the request ends, and the next read
   * fills again.
   */
  readonly waitUntil?: WaitUntil;
}

export interface WorkerVersionCacheOptions {
  /** The Workers cache of the data center. Null keeps the caches in memory. */
  readonly edgeCache?: EdgeCache | null;
  readonly waitUntil?: WaitUntil;
  /**
   * Keeps small blobs in the memory of the isolate too. Default true. A Worker
   * that caches its parsed results above the reader can turn it off, so the
   * isolate does not hold the same content twice.
   */
  readonly memoryBlobs?: boolean;
}

const EDGE_CACHE_ORIGIN = "https://docs-version-cache.internal";

/** Blobs are content-addressed, so an entry is valid forever. */
const EDGE_BLOB_TIER = {
  tier: "blobs",
  maxEntryBytes: 256 * 1024,
  maxAgeSeconds: 365 * 24 * 60 * 60,
} as const;

/**
 * A tree never changes, but a deleted version must stop resolving in the
 * end, so its entry expires. A tree holds at most 20,000 entries.
 */
const EDGE_TREE_TIER = {
  tier: "trees",
  maxEntryBytes: 4 * 1024 * 1024,
  maxAgeSeconds: 24 * 60 * 60,
} as const;

/** `caches.default` in the Workers runtime; null where it does not exist. */
export function workersDefaultCache(): EdgeCache | null {
  const storage = (
    globalThis as { caches?: CacheStorage & { default?: Cache } }
  ).caches;
  return storage?.default ?? null;
}

/**
 * A byte cache on the Workers Cache API, keyed by a synthetic URL that holds
 * the storage key. The URL is never fetched, and only Workers of the same
 * zone can read the entry. The cache of one data center is not shared with
 * other data centers.
 */
export function createEdgeByteCache(
  cache: EdgeCache,
  options: EdgeByteCacheOptions,
): VersionByteCache {
  const urlOf = (key: string) => `${EDGE_CACHE_ORIGIN}/${options.tier}/${key}`;
  const cacheControl = `public, max-age=${options.maxAgeSeconds}, immutable`;

  return {
    maxEntryBytes: options.maxEntryBytes,

    async get(key) {
      const cached = await cache.match(urlOf(key));
      return cached ? new Uint8Array(await cached.arrayBuffer()) : null;
    },

    put(key, bytes) {
      const stored = cache.put(
        urlOf(key),
        new Response(bytes.slice(), {
          headers: {
            "cache-control": cacheControl,
            "content-type": "application/octet-stream",
          },
        }),
      );
      options.waitUntil?.(stored.catch(() => undefined));
      return stored;
    },
  };
}

/**
 * The reader caches of a Worker, for one storage binding:
 *
 * - Trees: parsed in the memory of the isolate, then as bytes in the edge
 *   cache. A new isolate reads a tree that another isolate of the data
 *   center already read, without a storage call.
 * - Small blobs: in memory (unless `memoryBlobs` is false), then in the edge
 *   cache.
 *
 * Without an edge cache, the caches stay in memory only.
 */
export function workerVersionCaches(
  storage: object,
  options: WorkerVersionCacheOptions = {},
): VersionTreeReaderOptions {
  const edge = options.edgeCache;
  const edgeTier = (tier: Omit<EdgeByteCacheOptions, "waitUntil">) =>
    edge
      ? createEdgeByteCache(edge, { ...tier, waitUntil: options.waitUntil })
      : null;
  const blobTiers = [
    options.memoryBlobs === false ? null : sharedVersionBlobCache(storage),
    edgeTier(EDGE_BLOB_TIER),
  ].filter((tier): tier is VersionByteCache => tier !== null);

  return {
    cache: sharedVersionTreeCache(storage),
    blobCache:
      blobTiers.length > 1 ? chainVersionByteCaches(...blobTiers) : blobTiers[0],
    treeBytesCache: edgeTier(EDGE_TREE_TIER) ?? undefined,
  };
}
