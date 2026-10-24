import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildArtifactPrefix,
  siteBlobKey,
  writeVersionTree,
} from "@doxahq/docs-engine";
import { createR2DocsContentStore } from "../../src/services/docs-content/store";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const siteId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const prefix = buildArtifactPrefix(siteId, versionId);
const MDX = "text/plain; charset=utf-8";

/** A Workers `Cache` over a map, keyed by URL. */
function memoryCache() {
  const entries = new Map<string, Uint8Array>();
  const cache = {
    match: vi.fn(async (url: string) => {
      const bytes = entries.get(url);
      return bytes ? new Response(bytes.slice()) : undefined;
    }),
    put: vi.fn(async (url: string, response: Response) => {
      entries.set(url, new Uint8Array(await response.arrayBuffer()));
    }),
  };
  return { cache, entries };
}

async function site() {
  const storage = createMemoryR2Bucket();
  const bucket = storage.bucket;
  const written = await writeVersionTree(bucket, {
    siteId,
    versionId,
    files: [
      { path: "source/index.mdx", content: "# Home\n", contentType: MDX },
      { path: "source/guide/index.mdx", content: "# Guide\n", contentType: MDX },
    ],
  });
  storage.resetCalls();
  return { bucket, calls: storage.calls, written };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the R2 docs store with version caches", () => {
  test("a second read of the same content makes no blob read", async () => {
    const { bucket, calls } = await site();
    const store = createR2DocsContentStore(bucket);

    expect(await store.read(`${prefix}/source/index.mdx`)).toBe("# Home\n");
    expect(await store.read(`${prefix}/source/index.mdx`)).toBe("# Home\n");

    const blobReads = calls.get.filter((key) => key.includes("/blobs/"));
    expect(blobReads).toHaveLength(1);
  });

  test("a new isolate reads the tree and the blob from the edge cache, not from R2", async () => {
    const { cache } = memoryCache();
    vi.stubGlobal("caches", { default: cache });
    const { bucket, calls } = await site();
    const waits: Promise<unknown>[] = [];

    const warm = createR2DocsContentStore(bucket, {
      waitUntil: (promise) => waits.push(promise),
    });
    await warm.read(`${prefix}/source/guide/index.mdx`);
    await Promise.all(waits);

    // Another bucket object stands for another isolate: its memory is empty.
    const coldBucket = Object.create(bucket) as R2Bucket;
    calls.get.length = 0;
    const timings: string[] = [];
    const cold = createR2DocsContentStore(coldBucket, {
      measure: (name, step) => {
        timings.push(name);
        return step();
      },
    });

    expect(await cold.read(`${prefix}/source/guide/index.mdx`)).toBe("# Guide\n");
    expect(calls.get).toEqual([]);
    expect(timings).toEqual([]);
    expect(waits).toHaveLength(2);
  });

  test("a missing blob still fails, and nothing is cached for it", async () => {
    const { cache, entries } = memoryCache();
    vi.stubGlobal("caches", { default: cache });
    const { bucket, written } = await site();
    const blobKey = siteBlobKey(
      siteId,
      written.tree.files["source/index.mdx"].sha256,
    );
    await bucket.delete(blobKey);
    const store = createR2DocsContentStore(bucket);

    await expect(store.read(`${prefix}/source/index.mdx`)).rejects.toThrow(
      /missing/,
    );
    expect([...entries.keys()].filter((url) => url.includes("/blobs/"))).toEqual([]);
  });

  test("tree reads are measured as r2.tree when a timing is given", async () => {
    const { bucket } = await site();
    const names: string[] = [];
    const store = createR2DocsContentStore(bucket, {
      measure: (name, step) => {
        names.push(name);
        return step();
      },
    });

    await store.read(`${prefix}/source/index.mdx`);

    expect(names).toEqual(["r2.tree"]);
  });
});
