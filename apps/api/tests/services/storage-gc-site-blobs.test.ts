import { describe, expect, test } from "vitest";
import {
  siteBlobKey,
  versionTreeKey,
  writeVersionTree,
  type VersionTreeCommit,
} from "@doxahq/docs-engine";

import { createR2DocsObjectStore } from "../../src/services/docs-content/store";
import {
  BLOB_IN_FLIGHT_SECONDS,
  createDocsSiteBlobsCollector,
} from "../../src/services/storage-gc/collectors/docs-site-blobs";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const siteId = "11111111-1111-4111-8111-111111111111";
const liveId = "22222222-2222-4222-8222-222222222222";
const goneId = "33333333-3333-4333-8333-333333333333";
const otherSiteId = "44444444-4444-4444-8444-444444444444";
const TEXT = "text/plain; charset=utf-8";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - (BLOB_IN_FLIGHT_SECONDS + 60) * 1000);

function setup() {
  let clock = OLD;
  const storage = createMemoryR2Bucket({ now: () => clock });
  const collector = createDocsSiteBlobsCollector({
    objects: createR2DocsObjectStore(storage.bucket),
    now: () => NOW,
  });
  const write = (versionId: string, files: Record<string, string>, site = siteId) =>
    writeVersionTree(storage.bucket, {
      siteId: site,
      versionId,
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
        contentType: TEXT,
      })),
    });
  const deleteFolder = (site: string, versionId: string) =>
    storage.bucket.delete(
      [...storage.objects.keys()].filter((key) =>
        key.startsWith(`sites/${site}/versions/${versionId}/`),
      ),
    );
  const blobOf = (commit: VersionTreeCommit, path: string) =>
    siteBlobKey(commit.tree.siteId, commit.tree.files[path].sha256);
  return {
    storage,
    collector,
    write,
    deleteFolder,
    blobOf,
    setClock: (date: Date) => {
      clock = date;
    },
  };
}

describe("site blob sweep", () => {
  test("deletes only old blobs that no version tree references", async () => {
    const { storage, collector, write, deleteFolder, blobOf } = setup();
    const live = await write(liveId, {
      "manifest.json": "live manifest",
      "source/index.mdx": "shared page",
    });
    const gone = await write(goneId, {
      "manifest.json": "gone manifest",
      "source/index.mdx": "shared page",
    });
    const other = await write(liveId, { "manifest.json": "gone manifest" }, otherSiteId);
    await deleteFolder(siteId, goneId);

    const result = await collector.collect({ siteId });

    expect(result).toEqual({ deletedObjects: 1, status: "complete" });
    expect(storage.objects.has(blobOf(gone, "manifest.json"))).toBe(false);
    expect(storage.objects.has(blobOf(live, "manifest.json"))).toBe(true);
    expect(storage.objects.has(blobOf(live, "source/index.mdx"))).toBe(true);
    // The same bytes in another site are another blob.
    expect(storage.objects.has(blobOf(other, "manifest.json"))).toBe(true);
    expect(storage.objects.has(versionTreeKey(live.artifactPrefix))).toBe(true);
  });

  test("keeps a young unreferenced blob and asks to run again later", async () => {
    const { storage, collector, write, deleteFolder, blobOf, setClock } = setup();
    await write(liveId, { "manifest.json": "live" });
    setClock(new Date(NOW.getTime() - 60_000));
    const young = await write(goneId, { "manifest.json": "in flight" });
    await deleteFolder(siteId, goneId);

    const result = await collector.collect({ siteId });

    expect(result).toEqual({
      deletedObjects: 0,
      status: "incomplete",
      recheckAfterSeconds: BLOB_IN_FLIGHT_SECONDS,
    });
    expect(storage.objects.has(blobOf(young, "manifest.json"))).toBe(true);
  });

  test("deletes nothing when one version tree is invalid", async () => {
    const { storage, collector, write, deleteFolder } = setup();
    await write(liveId, { "manifest.json": "live" });
    await write(goneId, { "manifest.json": "gone" });
    await deleteFolder(siteId, goneId);
    await storage.bucket.put(
      versionTreeKey(`sites/${siteId}/versions/${goneId}`),
      "{broken",
    );
    const before = storage.objects.size;

    await expect(collector.collect({ siteId })).rejects.toThrow(/not JSON/);
    expect(storage.objects.size).toBe(before);
  });

  test("ignores old flat files in a version folder", async () => {
    const { storage, collector, write } = setup();
    const live = await write(liveId, { "manifest.json": "live" });
    await storage.bucket.put(`${live.artifactPrefix}/manifest.json`, "flat");
    await storage.bucket.put(`${live.artifactPrefix}/source/tree.json`, "flat");

    await expect(collector.collect({ siteId })).resolves.toEqual({
      deletedObjects: 0,
      status: "complete",
    });
  });

  test("accepts only a site id as its resource", () => {
    const { collector } = setup();

    expect(collector.parse({ siteId })).toEqual({ siteId });
    expect(() => collector.parse({ siteId, key: "sites/x/blobs/" })).toThrow();
    expect(() => collector.parse({ siteId: "../x" })).toThrow();
  });
});
