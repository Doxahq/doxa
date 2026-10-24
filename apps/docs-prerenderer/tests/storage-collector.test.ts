import { createPrerenderRenderPrefix } from "@doxahq/contracts/docs-prerender";
import { describe, expect, test, vi } from "vitest";

import { collectPrerenderRender } from "../src/storage-collector";

const siteId = "site-1";
const renderId = "a".repeat(64);
const prefix = createPrerenderRenderPrefix(siteId, renderId);

describe("pre-render storage collector", () => {
  test("deletes every object under the render prefix", async () => {
    const bucket = createBucket([
      `${prefix}manifest.json`,
      `${prefix}objects/${"b".repeat(64)}.html`,
      `${prefix}objects/${"c".repeat(64)}.json`,
    ]);

    await expect(
      collectPrerenderRender({ bucket, siteId, renderId }),
    ).resolves.toEqual({ deletedObjects: 3, status: "complete" });
    expect(bucket.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix }),
    );
    expect(bucket.delete).toHaveBeenCalledWith([
      `${prefix}manifest.json`,
      `${prefix}objects/${"b".repeat(64)}.html`,
      `${prefix}objects/${"c".repeat(64)}.json`,
    ]);
  });

  test("reports incomplete work when the object limit is reached", async () => {
    const bucket = createBucket([
      `${prefix}manifest.json`,
      `${prefix}objects/${"b".repeat(64)}.html`,
    ]);

    await expect(
      collectPrerenderRender({ bucket, siteId, renderId, limit: 1 }),
    ).resolves.toEqual({ deletedObjects: 1, status: "incomplete" });
  });

  test("never deletes a key outside the render prefix", async () => {
    const bucket = createBucket([
      `${prefix}manifest.json`,
      "render/v1/sites/other-site/renders/x/manifest.json",
    ]);

    await collectPrerenderRender({ bucket, siteId, renderId });

    expect(bucket.delete).toHaveBeenCalledWith([`${prefix}manifest.json`]);
  });

  test("rejects a render identity that is not well formed", async () => {
    const bucket = createBucket([]);

    await expect(
      collectPrerenderRender({
        bucket,
        siteId: "../other",
        renderId,
      }),
    ).rejects.toThrow();
    await expect(
      collectPrerenderRender({ bucket, siteId, renderId: "short" }),
    ).rejects.toThrow();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  test("returns a complete result for a render with no objects", async () => {
    const bucket = createBucket([]);

    await expect(
      collectPrerenderRender({ bucket, siteId, renderId }),
    ).resolves.toEqual({ deletedObjects: 0, status: "complete" });
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});

function createBucket(keys: string[]) {
  const remaining = new Set(keys);
  return {
    list: vi.fn(
      async (options: { prefix: string; limit?: number; cursor?: string }) => {
        const matching = [...remaining].slice(0, options.limit ?? 1_000);
        const truncated = matching.length < remaining.size;
        return {
          objects: matching.map((key) => ({ key })),
          truncated,
          ...(truncated ? { cursor: "next" } : {}),
        };
      },
    ),
    delete: vi.fn(async (deletedKeys: string[]) => {
      for (const key of deletedKeys) remaining.delete(key);
    }),
  };
}
