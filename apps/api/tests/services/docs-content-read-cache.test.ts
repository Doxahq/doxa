import { describe, expect, test } from "vitest";
import {
  withRequestReadCache,
  type DocsContentStore,
} from "../../src/services/docs-content/store";
import { createInMemoryDocsContentStore } from "../support/in-memory-docs-content-store";

const siteId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const prefix = `sites/${siteId}/versions/${versionId}`;

function countingStore(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const inner = createInMemoryDocsContentStore(objects);
  const reads: string[] = [];
  let failNextRead = false;
  const store: DocsContentStore = {
    ...inner,
    read: async (key) => {
      reads.push(key);
      if (failNextRead) {
        failNextRead = false;
        throw new Error("bucket unavailable");
      }
      return inner.read(key);
    },
  };

  return {
    store,
    reads,
    failNextRead: () => {
      failNextRead = true;
    },
  };
}

describe("the read cache for one request", () => {
  test("repeated and concurrent reads of a key make one bucket call", async () => {
    const { store, reads } = countingStore({ "v1/manifest.json": "{}" });
    const cached = withRequestReadCache(store);

    const [first, second] = await Promise.all([
      cached.read("v1/manifest.json"),
      cached.read("v1/manifest.json"),
    ]);
    const third = await cached.read("v1/manifest.json");

    expect([first, second, third]).toEqual(["{}", "{}", "{}"]);
    expect(await cached.read("v1/missing.json")).toBeNull();
    expect(await cached.read("v1/missing.json")).toBeNull();
    expect(reads).toEqual(["v1/manifest.json", "v1/missing.json"]);
  });

  test("a committed version is visible to the next read", async () => {
    const { store } = countingStore();
    const cached = withRequestReadCache(store);

    expect(await cached.read(`${prefix}/manifest.json`)).toBeNull();
    const writer = await cached.openVersion({ siteId, versionId });
    await writer.put("manifest.json", "{}");
    expect(await cached.read(`${prefix}/manifest.json`)).toBeNull();
    await writer.commit();

    expect(await cached.read(`${prefix}/manifest.json`)).toBe("{}");
  });

  test("a failed read is not kept", async () => {
    const { store, reads, failNextRead } = countingStore({ "v1/a.json": "a" });
    const cached = withRequestReadCache(store);

    failNextRead();
    await expect(cached.read("v1/a.json")).rejects.toThrow("bucket unavailable");
    expect(await cached.read("v1/a.json")).toBe("a");
    expect(reads).toEqual(["v1/a.json", "v1/a.json"]);
  });

  test("each cache is separate", async () => {
    const { store, reads } = countingStore({ "v1/a.json": "a" });

    await withRequestReadCache(store).read("v1/a.json");
    await withRequestReadCache(store).read("v1/a.json");

    expect(reads).toEqual(["v1/a.json", "v1/a.json"]);
  });
});
