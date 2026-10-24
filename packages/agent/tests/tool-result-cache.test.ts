import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { executeTool } from "../src/core/tool";
import { createTrackedTools } from "../src/core/tools/tracked";
import { createToolResultCache } from "../src/core/tools/result-cache";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("tool result cache", () => {
  test("reuses identical tool results", async () => {
    const cache = createToolResultCache();
    const compute = vi.fn(async () => "shared result");

    await expect(
      cache.resolve("Grep", { pattern: "createClient" }, compute),
    ).resolves.toBe("shared result");
    await expect(
      cache.resolve("Grep", { pattern: "createClient" }, compute),
    ).resolves.toBe("shared result");

    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  test("uses canonical argument order while keeping different arguments separate", async () => {
    const cache = createToolResultCache();
    const compute = vi.fn(async () => `result-${compute.mock.calls.length}`);

    const first = await cache.resolve("Grep", { a: 1, b: 2 }, compute);
    const reordered = await cache.resolve("Grep", { b: 2, a: 1 }, compute);
    const different = await cache.resolve("Grep", { a: 1, b: 3 }, compute);

    expect(reordered).toBe(first);
    expect(different).not.toBe(first);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(2);
  });

  test("does not retain oversized outputs", async () => {
    const cache = createToolResultCache({ maxEntryChars: 4 });
    const compute = vi.fn(async () => "oversized");

    await cache.resolve("Read", { path: "README.md" }, compute);
    await cache.resolve("Read", { path: "README.md" }, compute);
    await cache.resolve("Read", { path: "README.md" }, compute);

    expect(compute).toHaveBeenCalledTimes(3);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(3);
  });

  test("evicts the least recently used entry", async () => {
    const cache = createToolResultCache({ maxEntries: 2 });
    const computeA = vi.fn(async () => "a");
    const computeB = vi.fn(async () => "b");
    const computeC = vi.fn(async () => "c");

    await cache.resolve("Read", { path: "a.ts" }, computeA);
    await cache.resolve("Read", { path: "b.ts" }, computeB);
    await cache.resolve("Read", { path: "a.ts" }, computeA);
    await cache.resolve("Read", { path: "c.ts" }, computeC);
    await cache.resolve("Read", { path: "b.ts" }, computeB);

    expect(computeA).toHaveBeenCalledTimes(1);
    expect(computeB).toHaveBeenCalledTimes(2);
    expect(computeC).toHaveBeenCalledTimes(1);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(4);
  });

  test("coalesces concurrent identical computations", async () => {
    const cache = createToolResultCache();
    let release: ((value: string) => void) | undefined;
    const compute = vi.fn(
      () => new Promise<string>((resolve) => {
        release = resolve;
      }),
    );

    const first = cache.resolve("Grep", { pattern: "shared" }, compute);
    const second = cache.resolve("Grep", { pattern: "shared" }, compute);
    release?.("result");

    await expect(Promise.all([first, second])).resolves.toEqual([
      "result",
      "result",
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  test("emits one tool span per invocation and attributes cache reuse", async () => {
    const project = await mkdtemp(join(tmpdir(), "doxa-tool-cache-"));
    temporaryDirectories.push(project);
    await writeFile(
      join(project, "index.ts"),
      "export function createClient() {}\n",
      "utf8",
    );
    const cache = createToolResultCache();
    const tracked = createTrackedTools(project, "read_only", {
      resultCache: cache,
    });
    const spans: Array<{ name: string; reused?: boolean }> = [];
    const context = {
      onSpan: (span: { name: string; reused?: boolean }) => {
        spans.push(span);
      },
    };
    const argumentsJson = JSON.stringify({
      pattern: "createClient",
      path: ".",
    });

    await executeTool(tracked.tools, "Grep", argumentsJson, context);
    await executeTool(tracked.tools, "Grep", argumentsJson, context);

    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ name: "Grep" });
    expect(spans[0]?.reused).toBeUndefined();
    expect(spans[1]).toMatchObject({ name: "Grep", reused: true });
  });
});
