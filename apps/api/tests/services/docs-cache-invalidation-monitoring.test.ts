import { afterEach, describe, expect, test, vi } from "vitest";

const built = vi.hoisted(() => ({ workers: [] as unknown[][] }));
vi.mock("@doxahq/db", async (original) => ({
  ...(await original<typeof import("@doxahq/db")>()),
  createDb: () => ({}),
}));
vi.mock("../../src/services/docs-cache-invalidation", async (original) => {
  const actual =
    await original<typeof import("../../src/services/docs-cache-invalidation")>();
  return {
    ...actual,
    DocsCacheInvalidationWorker: class {
      constructor(...args: unknown[]) {
        built.workers.push(args);
      }
      process = async () => ({ completed: 0, failed: 0 });
    },
  };
});

import { DocsHostnameSourceRepository } from "../../src/repositories/docs-hostname-source";
import { DocsCacheInvalidationMaintenance } from "../../src/services/docs-cache-invalidation-monitoring";

const healthyQueue = {
  pendingCount: 0,
  delayedCount: 0,
  failedCount: 0,
  oldestPendingAgeSeconds: 0,
  maxAttempts: 0,
};

describe("docs cache invalidation monitoring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("records a healthy scheduled run without a warning", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const maintenance = new DocsCacheInvalidationMaintenance(
      { process: async () => ({ completed: 2, failed: 0 }) },
      { readHealth: async () => healthyQueue },
    );

    const event = await maintenance.run();

    expect(event).toEqual({
      event: "docs_cache_invalidation_health",
      status: "healthy",
      processed: { completed: 2, failed: 0 },
      queue: healthyQueue,
    });
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual(event);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    { delayedCount: 1, failedCount: 0 },
    { delayedCount: 0, failedCount: 1 },
  ])(
    "warns when delayed=$delayedCount and failed=$failedCount work remains",
    async ({ delayedCount, failedCount }) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const maintenance = new DocsCacheInvalidationMaintenance(
        { process: async () => ({ completed: 0, failed: failedCount }) },
        {
          readHealth: async () => ({
            ...healthyQueue,
            pendingCount: 1,
            delayedCount,
            failedCount,
            oldestPendingAgeSeconds: 600,
            maxAttempts: 2,
          }),
        },
      );

      const event = await maintenance.run();

      expect(event.status).toBe("degraded");
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual(event);
    },
  );

  test("rewrites the hostname map for every task it retries, as the first delivery does", () => {
    const binding = { invalidate: vi.fn(), syncHostnames: vi.fn() };
    DocsCacheInvalidationMaintenance.fromEnv({
      DOCS_CACHE_INVALIDATOR: binding,
    } as never);

    const [args] = built.workers.slice(-1);
    expect(args?.[1]).toBe(binding);
    expect(args?.[2]).toBeInstanceOf(DocsHostnameSourceRepository);
  });
});
