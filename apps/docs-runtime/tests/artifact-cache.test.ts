import { afterEach, describe, expect, test, vi } from "vitest";
import { loadFrozenArtifactSetByName } from "@doxahq/docs-artifact-fixtures";
import { artifactReader } from "../src/artifact-storage";
import { createTreeBucket } from "./support/tree-bucket";

const set = loadFrozenArtifactSetByName(2, "starter");
const manifestKey = `${set.artifactPrefix}/manifest.json`;

/** A Workers `Cache` over a map, keyed by URL. */
function memoryEdgeCache() {
  const entries = new Map<string, Uint8Array>();
  const cache = {
    match: async (url: string) => {
      const bytes = entries.get(url);
      return bytes ? new Response(bytes.slice()) : undefined;
    },
    put: async (url: string, response: Response) => {
      entries.set(url, new Uint8Array(await response.arrayBuffer()));
    },
  };
  return { cache, entries };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact storage with the Workers cache", () => {
  test("a new isolate reads the tree and the blob without R2", async () => {
    const { cache, entries } = memoryEdgeCache();
    vi.stubGlobal("caches", { default: cache });
    const { bucket } = createTreeBucket(set.objects);

    const warm = await artifactReader({ DOCS_BUCKET: bucket }).get(manifestKey);
    expect(await warm?.text()).toBe(set.objects[manifestKey]);
    await vi.waitFor(() => expect(entries.size).toBe(2));

    // Another bucket object stands for another isolate: its memory is empty.
    const cold = Object.create(bucket) as R2Bucket;
    vi.mocked(bucket.get).mockClear();

    const read = await artifactReader({ DOCS_BUCKET: cold }).get(manifestKey);
    expect(await read?.text()).toBe(set.objects[manifestKey]);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  test("reads R2 when the data center has no Workers cache", async () => {
    const { bucket } = createTreeBucket(set.objects);

    const read = await artifactReader({ DOCS_BUCKET: bucket }).get(manifestKey);

    expect(await read?.text()).toBe(set.objects[manifestKey]);
    expect(bucket.get).toHaveBeenCalled();
  });
});
