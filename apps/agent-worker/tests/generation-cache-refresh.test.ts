import { emptyPageDependencyState } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  cacheObjectNeedsRefresh,
  refreshAgingCacheObject,
} from "../src/generation-cache-refresh";
import {
  createR2GenerationPageCache,
  type PageCacheEntry,
} from "../src/generation-page-cache";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-10-16T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

class UploadedBucket {
  readonly objects = new Map<string, { body: string; uploaded: Date }>();
  readonly puts: { key: string; contentType: string | undefined }[] = [];
  failPut = false;

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      uploaded: object.uploaded,
      text: async () => object.body,
    } as R2ObjectBody;
  }

  async put(key: string, value: string, options?: R2PutOptions) {
    if (this.failPut) throw new Error("R2 unavailable");
    this.objects.set(key, { body: value, uploaded: NOW });
    const metadata = options?.httpMetadata;
    this.puts.push({
      key,
      contentType: metadata && !(metadata instanceof Headers)
        ? metadata.contentType
        : undefined,
    });
    return null;
  }
}

const entry: PageCacheEntry = {
  page: {
    id: "overview",
    title: "Overview",
    route: "/overview",
    navigationPath: "default/overview.md",
    content: "# Overview\n",
    dependencies: emptyPageDependencyState(),
    contentHash: "d".repeat(64),
    pageInputHash: "a".repeat(64),
  },
  writerModel: "model-a",
  writingFingerprint: "fingerprint-a",
  createdAt: "2026-07-30T00:00:00.000Z",
};

describe("cache object refresh", () => {
  test("refreshes an object uploaded 20 days ago or earlier", () => {
    expect(cacheObjectNeedsRefresh(daysAgo(19.9), NOW)).toBe(false);
    expect(cacheObjectNeedsRefresh(daysAgo(20), NOW)).toBe(true);
    expect(cacheObjectNeedsRefresh(daysAgo(29), NOW)).toBe(true);
  });

  test("writes the same bytes again and reports the refresh", async () => {
    const bucket = new UploadedBucket();
    const refreshed = await refreshAgingCacheObject(bucket, {
      key: "cache/pages/a.json",
      uploaded: daysAgo(21),
      body: "{\"a\":1}",
      contentType: "application/json; charset=utf-8",
    }, NOW);

    expect(refreshed).toBe(true);
    expect(bucket.objects.get("cache/pages/a.json")?.body).toBe("{\"a\":1}");
    expect(bucket.puts).toEqual([{
      key: "cache/pages/a.json",
      contentType: "application/json; charset=utf-8",
    }]);
  });

  test("swallows a failed refresh", async () => {
    const bucket = new UploadedBucket();
    bucket.failPut = true;

    await expect(refreshAgingCacheObject(bucket, {
      key: "cache/pages/a.json",
      uploaded: daysAgo(25),
      body: "{}",
      contentType: "application/json",
    }, NOW)).resolves.toBe(false);
  });
});

describe("R2 page cache refresh on read", () => {
  test("rewrites an aging hit and leaves a young hit alone", async () => {
    const bucket = new UploadedBucket();
    const body = JSON.stringify(entry);
    bucket.objects.set("cache/pages/old.json", { body, uploaded: daysAgo(21) });
    bucket.objects.set("cache/pages/new.json", { body, uploaded: daysAgo(2) });
    const cache = createR2GenerationPageCache(bucket, { now: () => NOW });

    const hits = await cache.getMany([
      "cache/pages/old.json",
      "cache/pages/new.json",
    ]);

    expect([...hits.keys()].sort()).toEqual([
      "cache/pages/new.json",
      "cache/pages/old.json",
    ]);
    expect(bucket.puts.map(({ key }) => key)).toEqual(["cache/pages/old.json"]);
    expect(bucket.objects.get("cache/pages/old.json")).toEqual({
      body,
      uploaded: NOW,
    });
  });

  test("never rewrites an invalid entry", async () => {
    const bucket = new UploadedBucket();
    bucket.objects.set("cache/pages/bad.json", {
      body: "{\"page\":",
      uploaded: daysAgo(25),
    });
    const cache = createR2GenerationPageCache(bucket, { now: () => NOW });

    await expect(cache.getMany(["cache/pages/bad.json"])).resolves.toEqual(
      new Map(),
    );
    expect(bucket.puts).toEqual([]);
  });

  test("still returns the hit when the refresh fails", async () => {
    const bucket = new UploadedBucket();
    bucket.objects.set("cache/pages/old.json", {
      body: JSON.stringify(entry),
      uploaded: daysAgo(22),
    });
    bucket.failPut = true;
    const cache = createR2GenerationPageCache(bucket, { now: () => NOW });

    const hits = await cache.getMany(["cache/pages/old.json"]);
    expect(hits.size).toBe(1);
  });
});
