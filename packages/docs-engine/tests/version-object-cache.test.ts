import { describe, expect, test, vi } from "vitest";
import {
  VERSION_BLOB_CACHE_CONTROL,
  VERSION_OBJECT_CACHE_ORIGIN,
  VERSION_TREE_CACHE_CONTROL,
  createVersionObjectStorage,
  respondWithVersionObject,
  type VersionObjectFetcher,
  type VersionObjectReadSource,
} from "../src/version-object-cache";
import {
  VersionTreeCache,
  createVersionTreeReader,
  parseImmutableStorageKey,
  serializeVersionTree,
  sha256Hex,
  siteBlobKey,
  versionTreeKey,
  writeVersionTree,
  type VersionTreeObject,
  type VersionTreeStorage,
} from "../src/version-tree";

const siteId = "11111111-1111-4111-8111-111111111111";
const otherSiteId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const prefix = `sites/${siteId}/versions/${versionId}`;
const MDX = "text/plain; charset=utf-8";
const HOME = "# Home\n";

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
  };
}

async function writeSite(storage: VersionTreeStorage) {
  return writeVersionTree(storage, {
    siteId,
    versionId,
    files: [{ path: "source/index.mdx", content: HOME, contentType: MDX }],
  });
}

/**
 * A Workers Cache entrypoint over a map: a miss runs the endpoint and keeps
 * a cacheable 200, like the real cache.
 */
function workersCacheOver(storage: Pick<VersionTreeStorage, "get">) {
  const entries = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  const fetcher: VersionObjectFetcher = {
    fetch: vi.fn(async (request: Request) => {
      const entry = entries.get(request.url);
      if (entry) {
        const headers = new Headers(entry.headers);
        headers.set("cf-cache-status", "HIT");
        return new Response(entry.bytes.slice(), { headers });
      }
      const response = await respondWithVersionObject(storage, request);
      const headers = new Headers(response.headers);
      headers.set("cf-cache-status", "MISS");
      if (response.status !== 200) {
        return new Response(response.body, { status: response.status, headers });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      entries.set(request.url, { bytes, headers: response.headers });
      return new Response(bytes.slice(), { headers });
    }),
  };
  return { fetcher, entries };
}

function objectRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${VERSION_OBJECT_CACHE_ORIGIN}/${path}`, init);
}

/** A reader with the memory of a new isolate. */
function readerOver(
  storage: Pick<VersionTreeStorage, "get">,
  onRead?: (source: VersionObjectReadSource) => void,
  cache?: VersionObjectFetcher,
) {
  return createVersionTreeReader(
    createVersionObjectStorage(storage, { cache, onRead }),
    { cache: new VersionTreeCache() },
  );
}

describe("parseImmutableStorageKey", () => {
  test("accepts the blob and tree keys of the tree layer", async () => {
    const sha = await sha256Hex(new TextEncoder().encode(HOME));

    expect(parseImmutableStorageKey(siteBlobKey(siteId, sha))).toEqual({
      kind: "blob",
      key: siteBlobKey(siteId, sha),
      siteId,
      sha256: sha,
    });
    expect(parseImmutableStorageKey(versionTreeKey(prefix))).toEqual({
      kind: "tree",
      key: versionTreeKey(prefix),
      siteId,
      versionId,
    });
  });

  test.each([
    `${prefix}/manifest.json`,
    `${prefix}/source/index.mdx`,
    `${prefix}/tree.json/extra`,
    `sites/${siteId}/assets/${"a".repeat(64)}`,
    `sites/${siteId}/blobs/${"A".repeat(64)}`,
    `sites/${siteId}/blobs/${"a".repeat(63)}`,
    `sites/${siteId}/blobs/${"a".repeat(64)}/x`,
    `sites/../blobs/${"a".repeat(64)}`,
    `sites/.hidden/versions/${versionId}/tree.json`,
    `sites/${siteId}/versions/%2e%2e/tree.json`,
    `/sites/${siteId}/blobs/${"a".repeat(64)}`,
    "",
  ])("rejects %s", (key) => {
    expect(parseImmutableStorageKey(key)).toBeNull();
  });
});

describe("respondWithVersionObject", () => {
  test("returns a blob with a permanent cache lifetime and a site tag", async () => {
    const { storage } = memoryStorage();
    const commit = await writeSite(storage);
    const sha = commit.tree.files["source/index.mdx"]!.sha256;

    const response = await respondWithVersionObject(
      storage,
      objectRequest(siteBlobKey(siteId, sha)),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HOME);
    expect(response.headers.get("cache-control")).toBe(
      VERSION_BLOB_CACHE_CONTROL,
    );
    expect(response.headers.get("cache-tag")).toBe(
      `docs-objects-site:${siteId}`,
    );
  });

  test("returns a tree with a bounded lifetime and a version tag", async () => {
    const { storage } = memoryStorage();
    const commit = await writeSite(storage);

    const response = await respondWithVersionObject(
      storage,
      objectRequest(versionTreeKey(prefix)),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(serializeVersionTree(commit.tree));
    expect(response.headers.get("cache-control")).toBe(
      VERSION_TREE_CACHE_CONTROL,
    );
    expect(response.headers.get("cache-tag")).toBe(
      `docs-objects-site:${siteId},docs-objects-version:${siteId}/${versionId}`,
    );
  });

  test("does not cache a missing object", async () => {
    const { storage } = memoryStorage();

    const response = await respondWithVersionObject(
      storage,
      objectRequest(versionTreeKey(prefix)),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test.each([
    ["a logical key", objectRequest(`${prefix}/manifest.json`)],
    ["a site asset", objectRequest(`sites/${siteId}/assets/${"a".repeat(64)}`)],
    ["a query", objectRequest(`${versionTreeKey(prefix)}?v=1`)],
    ["a POST", objectRequest(versionTreeKey(prefix), { method: "POST" })],
    ["a HEAD", objectRequest(versionTreeKey(prefix), { method: "HEAD" })],
    [
      "another origin",
      new Request(`https://example.com/${versionTreeKey(prefix)}`),
    ],
    [
      "an encoded path",
      objectRequest(`sites/${siteId}/versions/%33${versionId.slice(1)}/tree.json`),
    ],
  ])("rejects %s without reading storage", async (_name, request) => {
    const { storage, gets } = memoryStorage();
    await writeSite(storage);
    gets.length = 0;

    const response = await respondWithVersionObject(storage, request);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(gets).toEqual([]);
  });

  test("does not cache a blob whose bytes do not match its hash", async () => {
    const { storage, objects } = memoryStorage();
    const commit = await writeSite(storage);
    const key = siteBlobKey(siteId, commit.tree.files["source/index.mdx"]!.sha256);
    objects.set(key, new TextEncoder().encode("# Damaged\n"));

    const response = await respondWithVersionObject(storage, objectRequest(key));

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("does not cache a tree of another folder", async () => {
    const { storage, objects } = memoryStorage();
    const commit = await writeSite(storage);
    const otherPrefix = `sites/${otherSiteId}/versions/${versionId}`;
    objects.set(
      versionTreeKey(otherPrefix),
      new TextEncoder().encode(serializeVersionTree(commit.tree)),
    );

    const response = await respondWithVersionObject(
      storage,
      objectRequest(versionTreeKey(otherPrefix)),
    );

    expect(response.status).toBe(502);
  });

  test("answers 503 without caching when storage fails", async () => {
    const storage = {
      get: async () => {
        throw new Error("R2 is down");
      },
    };

    const response = await respondWithVersionObject(
      storage,
      objectRequest(versionTreeKey(prefix)),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("createVersionObjectStorage", () => {
  test("a new isolate reads the tree and the blob from the cache", async () => {
    const { storage, gets } = memoryStorage();
    await writeSite(storage);
    const { fetcher } = workersCacheOver(storage);
    const reads: VersionObjectReadSource[] = [];

    const warm = await readerOver(storage, (s) => reads.push(s), fetcher).get(
      `${prefix}/source/index.mdx`,
    );
    expect(await warm?.text()).toBe(HOME);
    expect(reads).toEqual(["storage", "storage"]);

    gets.length = 0;
    reads.length = 0;
    const cold = await readerOver(storage, (s) => reads.push(s), fetcher).get(
      `${prefix}/source/index.mdx`,
    );

    expect(await cold?.text()).toBe(HOME);
    expect(reads).toEqual(["cache", "cache"]);
    expect(gets).toEqual([]);
  });

  test("sends only immutable keys to the cache", async () => {
    const { storage, objects } = memoryStorage();
    objects.set(`sites/${siteId}/assets/logo`, new TextEncoder().encode("x"));
    const { fetcher } = workersCacheOver(storage);

    const read = await readerOver(storage, undefined, fetcher).get(
      `sites/${siteId}/assets/logo`,
    );

    expect(await read?.text()).toBe("x");
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  test("reads storage for a site that does not use the cache", async () => {
    const { storage } = memoryStorage();
    await writeSite(storage);
    const { fetcher } = workersCacheOver(storage);
    const reader = createVersionTreeReader(
      createVersionObjectStorage(storage, {
        cache: fetcher,
        useCache: (key) => key.siteId !== siteId,
      }),
    );

    expect(await (await reader.get(`${prefix}/source/index.mdx`))?.text()).toBe(
      HOME,
    );
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  test("keeps a missing version missing", async () => {
    const { storage } = memoryStorage();
    const { fetcher } = workersCacheOver(storage);
    const reads: VersionObjectReadSource[] = [];

    expect(
      await readerOver(storage, (s) => reads.push(s), fetcher).get(
        `${prefix}/manifest.json`,
      ),
    ).toBeNull();
    expect(reads).toEqual(["storage"]);
  });

  test.each([
    [
      "throws",
      async () => {
        throw new Error("loopback failed");
      },
    ],
    ["answers 503", async () => new Response("down", { status: 503 })],
    ["answers 400", async () => new Response("no", { status: 400 })],
  ])("reads storage when the cache %s", async (_name, fetch) => {
    const { storage, gets } = memoryStorage();
    await writeSite(storage);
    gets.length = 0;
    const reads: VersionObjectReadSource[] = [];

    const read = await readerOver(storage, (s) => reads.push(s), { fetch }).get(
      `${prefix}/source/index.mdx`,
    );

    expect(await read?.text()).toBe(HOME);
    expect(gets).toHaveLength(2);
    expect(reads).toEqual(["storage", "storage"]);
  });

  test("reads storage without a cache", async () => {
    const { storage, gets } = memoryStorage();
    await writeSite(storage);
    gets.length = 0;

    const read = await readerOver(storage).get(`${prefix}/source/index.mdx`);

    expect(await read?.text()).toBe(HOME);
    expect(gets).toHaveLength(2);
  });
});
