import {
  parseImmutableStorageKey,
  parseVersionTreeText,
  sha256Hex,
  type ImmutableStorageKey,
  type VersionTreeObject,
  type VersionTreeStorage,
} from "./version-tree";

/**
 * A shared HTTP cache in front of the immutable objects of the version tree
 * reader: blobs and trees.
 *
 * The cache is a `fetch` endpoint, for example a Workers Cache entrypoint.
 * The reader side (`createVersionObjectStorage`) asks it for one object per
 * request. The endpoint side (`respondWithVersionObject`) reads storage only
 * on a miss, checks the bytes against their key, and marks them cacheable.
 *
 * Only keys that the tree layer builds reach the endpoint: a blob key comes
 * from a parsed tree, and a tree key from a resolved version folder. The
 * endpoint accepts no other key. Each key holds its site id, so two sites
 * never share an entry.
 */

/** The origin of an object request. The URL is never resolved. */
export const VERSION_OBJECT_CACHE_ORIGIN = "https://docs-object-cache.internal";

/** A blob key is the hash of its bytes, so its entry is valid forever. */
export const VERSION_BLOB_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * A tree never changes, but its folder can be collected. The reader resolves
 * a version through its database row first, so it never asks for a collected
 * tree; the entry still expires, so a collected tree leaves the cache.
 */
export const VERSION_TREE_CACHE_CONTROL = "public, max-age=86400";

const UNCACHED = "private, no-store";

/** `cf-cache-status` values of a response that the cache served. */
const CACHE_HIT_STATUSES = new Set(["HIT", "STALE", "UPDATING", "REVALIDATED"]);

/** The part of a Workers service binding that the cache uses. */
export interface VersionObjectFetcher {
  fetch(request: Request): Promise<Response>;
}

/** Where one storage read was served. */
export type VersionObjectReadSource = "cache" | "storage";

export interface VersionObjectStorageOptions {
  /** The cache endpoint. Without it, every read goes to storage. */
  readonly cache?: VersionObjectFetcher | null;
  /** Whether a key goes through the cache. Default: every immutable key. */
  readonly useCache?: (key: ImmutableStorageKey) => boolean;
  /**
   * Reports each read. `storage` counts every read that reached storage,
   * also the fill of a cache miss.
   */
  readonly onRead?: (source: VersionObjectReadSource) => void;
}

/** The URL of one object in the cache. The path is the storage key. */
export function versionObjectCacheUrl(key: ImmutableStorageKey): string {
  return `${VERSION_OBJECT_CACHE_ORIGIN}/${key.key}`;
}

/**
 * The storage of a version tree reader that reads blobs and trees through the
 * cache. Every other key goes to storage unchanged. When the cache fails, the
 * read goes to storage, so the cache can never fail a read.
 */
export function createVersionObjectStorage(
  storage: Pick<VersionTreeStorage, "get">,
  options: VersionObjectStorageOptions = {},
): Pick<VersionTreeStorage, "get"> {
  const report = (source: VersionObjectReadSource) => options.onRead?.(source);
  const readStorage = (key: string) => {
    report("storage");
    return storage.get(key);
  };

  return {
    async get(key) {
      const immutable = parseImmutableStorageKey(key);
      const cache = options.cache;

      if (!cache || !immutable || options.useCache?.(immutable) === false) {
        return readStorage(key);
      }

      const response = await fetchCachedObject(cache, immutable);

      if (!response) {
        return readStorage(key);
      }

      report(isCacheHit(response) ? "cache" : "storage");

      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }

      return responseObject(response);
    },
  };
}

/**
 * The cache response for an object: 200 or 404. Null when the cache failed;
 * the caller then reads storage.
 */
async function fetchCachedObject(
  cache: VersionObjectFetcher,
  key: ImmutableStorageKey,
): Promise<Response | null> {
  let response: Response;

  try {
    response = await cache.fetch(
      new Request(versionObjectCacheUrl(key), { method: "GET" }),
    );
  } catch {
    return null;
  }

  if (response.status === 200 || response.status === 404) {
    return response;
  }

  await response.body?.cancel();
  return null;
}

function isCacheHit(response: Response): boolean {
  const status = response.headers.get("cf-cache-status");
  return status !== null && CACHE_HIT_STATUSES.has(status.toUpperCase());
}

/** An object over a response body. The body is read once. */
function responseObject(response: Response): VersionTreeObject {
  let bytes: Promise<ArrayBuffer> | null = null;
  const read = () => (bytes ??= response.arrayBuffer());

  return {
    text: async () => new TextDecoder().decode(await read()),
    // A copy, so two readers of one object never share a buffer.
    arrayBuffer: async () => (await read()).slice(0),
  };
}

// ---------------------------------------------------------------------------
// Endpoint

/**
 * The cache endpoint. It answers a GET for one object URL:
 *
 * - 200 with the stored bytes and a long cache lifetime,
 * - 404 when storage has no object,
 * - 400 for any other request,
 * - 502 when the bytes do not match their key, and 503 when storage fails.
 *
 * Only a 200 is cacheable. A missing object is never kept: a publish can
 * write it a moment later.
 */
export async function respondWithVersionObject(
  storage: Pick<VersionTreeStorage, "get">,
  request: Request,
): Promise<Response> {
  const key = parseVersionObjectRequest(request);

  if (!key) {
    return uncached(400, "Invalid object request");
  }

  let bytes: Uint8Array<ArrayBuffer> | null;

  try {
    const object = await storage.get(key.key);
    bytes = object ? new Uint8Array(await object.arrayBuffer()) : null;
  } catch {
    return uncached(503, "Storage is unavailable");
  }

  if (!bytes) {
    return uncached(404, "Not found");
  }

  if (!(await matchesKey(key, bytes))) {
    return uncached(502, "The object does not match its key");
  }

  return new Response(bytes, {
    headers: {
      "cache-control":
        key.kind === "blob"
          ? VERSION_BLOB_CACHE_CONTROL
          : VERSION_TREE_CACHE_CONTROL,
      "cache-tag": versionObjectCacheTags(key).join(","),
      "content-type": "application/octet-stream",
    },
  });
}

/**
 * The key of an object request, or null. The URL must be exactly the object
 * URL of an immutable key: no query, no fragment, no other origin.
 */
export function parseVersionObjectRequest(
  request: Request,
): ImmutableStorageKey | null {
  if (request.method !== "GET") {
    return null;
  }

  let url: URL;

  try {
    url = new URL(request.url);
  } catch {
    return null;
  }

  if (
    url.origin !== VERSION_OBJECT_CACHE_ORIGIN ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  const key = parseImmutableStorageKey(url.pathname.slice(1));
  return key && versionObjectCacheUrl(key) === url.href ? key : null;
}

/**
 * Tags for a purge by site or by version folder. Tags are scoped to the
 * cache endpoint, and tag matching ignores case.
 */
export function versionObjectCacheTags(key: ImmutableStorageKey): string[] {
  const site = `docs-objects-site:${key.siteId}`;
  return key.kind === "tree"
    ? [site, `docs-objects-version:${key.siteId}/${key.versionId}`]
    : [site];
}

/** Damaged bytes are never cached: a blob must hash to its key. */
async function matchesKey(
  key: ImmutableStorageKey,
  bytes: Uint8Array,
): Promise<boolean> {
  if (key.kind === "blob") {
    return (await sha256Hex(bytes)) === key.sha256;
  }

  try {
    parseVersionTreeText(new TextDecoder().decode(bytes), key);
    return true;
  } catch {
    return false;
  }
}

function uncached(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "cache-control": UNCACHED },
  });
}
