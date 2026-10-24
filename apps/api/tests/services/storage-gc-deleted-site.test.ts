import { describe, expect, test, vi } from "vitest";
import { STORAGE_GC_LIMITS } from "@doxahq/contracts/storage-gc";
import { writeVersionTree } from "@doxahq/docs-engine";

import { createR2DocsObjectStore } from "../../src/services/docs-content/store";
import { createDocsDeletedSiteCollector } from "../../src/services/storage-gc/collectors/docs-deleted-site";
import {
  BLOB_IN_FLIGHT_SECONDS,
  createDocsSiteBlobsCollector,
} from "../../src/services/storage-gc/collectors/docs-site-blobs";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const siteId = "11111111-1111-4111-8111-111111111111";
const otherSiteId = "44444444-4444-4444-8444-444444444444";
const versionA = "22222222-2222-4222-8222-222222222222";
const versionB = "33333333-3333-4333-8333-333333333333";
const TEXT = "text/plain; charset=utf-8";
const NOW = new Date("2026-10-03T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - (BLOB_IN_FLIGHT_SECONDS + 60) * 1000);

function setup(input: { siteExists?: boolean } = {}) {
  const storage = createMemoryR2Bucket({ now: () => OLD });
  const objects = createR2DocsObjectStore(storage.bucket);
  const onCollected = vi.fn(async () => undefined);
  const collector = createDocsDeletedSiteCollector({
    sites: { siteExists: async () => input.siteExists ?? false },
    objects,
    onCollected,
  });
  const write = (site: string, versionId: string) =>
    writeVersionTree(storage.bucket, {
      siteId: site,
      versionId,
      files: [
        { path: "manifest.json", content: `{"v":"${versionId}"}`, contentType: TEXT },
        { path: "source/index.mdx", content: "# Shared", contentType: TEXT },
      ],
    });
  const keysOf = (site: string) =>
    [...storage.objects.keys()].filter((key) => key.startsWith(`sites/${site}/`));
  return { storage, objects, collector, onCollected, write, keysOf };
}

describe("docs_deleted_site collector", () => {
  test("keeps the storage while the site row exists", async () => {
    const { collector } = setup({ siteExists: true });

    await expect(collector.inspect({ siteId })).resolves.toEqual({
      status: "retain",
      reason: "site_exists",
    });
  });

  test("rejects a resource that is not a site id", () => {
    const { collector } = setup();

    expect(() => collector.parse({ siteId: "../other" })).toThrow();
    expect(() => collector.parse({ siteId, prefix: "sites/" })).toThrow();
  });

  test("deletes every folder of the site, then the blob sweep deletes the blobs", async () => {
    const { storage, objects, collector, onCollected, write, keysOf } = setup();
    await write(siteId, versionA);
    await write(siteId, versionB);
    await write(otherSiteId, versionA);
    await storage.bucket.put(`sites/${siteId}/assets/${"a".repeat(64)}`, "logo");
    await storage.bucket.put(
      `sites/${siteId}/generation-state/${versionA}/state.json`,
      "{}",
    );
    const otherSiteKeys = keysOf(otherSiteId);

    await expect(collector.inspect({ siteId })).resolves.toEqual({
      status: "collect",
    });
    await expect(collector.collect({ siteId })).resolves.toMatchObject({
      status: "complete",
    });

    // Only blobs are left, and this collector never deletes one.
    expect(keysOf(siteId).length).toBeGreaterThan(0);
    expect(keysOf(siteId).every((key) => key.startsWith(`sites/${siteId}/blobs/`))).toBe(true);
    expect(onCollected).toHaveBeenCalledWith({ siteId });

    const sweep = createDocsSiteBlobsCollector({ objects, now: () => NOW });
    await expect(sweep.collect({ siteId })).resolves.toMatchObject({
      status: "complete",
    });

    expect(keysOf(siteId)).toEqual([]);
    expect(keysOf(otherSiteId)).toEqual(otherSiteKeys);
  });

  test("returns to the work list when the site has more objects than one run deletes", async () => {
    const { storage, collector, onCollected, keysOf } = setup();
    const count = STORAGE_GC_LIMITS.objectsPerEntry + 5;
    for (let index = 0; index < count; index += 1) {
      await storage.bucket.put(`sites/${siteId}/assets/${index}`, "x");
    }

    await expect(collector.collect({ siteId })).resolves.toEqual({
      deletedObjects: STORAGE_GC_LIMITS.objectsPerEntry,
      status: "incomplete",
    });
    expect(onCollected).not.toHaveBeenCalled();
    expect(keysOf(siteId)).toHaveLength(5);

    await expect(collector.collect({ siteId })).resolves.toEqual({
      deletedObjects: 5,
      status: "complete",
    });
    expect(onCollected).toHaveBeenCalledTimes(1);
  });
});
