import { afterEach, describe, expect, test, vi } from "vitest";
import { DocsCacheInvalidationWorker } from "../../src/services/docs-cache-invalidation";
import type {
  ClaimedDocsCacheInvalidation,
  DocsCacheInvalidationStore,
} from "../../src/repositories/docs-cache-invalidations";

const task: ClaimedDocsCacheInvalidation = {
  id: "task-1",
  siteId: "site-1",
  hostname: null,
  attempts: 1,
  claimToken: "claim-1",
};

function fixture(tasks = [task]) {
  const completed: string[] = [];
  const failed: Array<{ id: string; error: string; delay: number }> = [];
  const store: DocsCacheInvalidationStore = {
    claim: async () => tasks,
    complete: async (item) => {
      completed.push(item.id);
    },
    fail: async (item, error, delay) => {
      failed.push({ id: item.id, error, delay });
    },
  };
  return { store, completed, failed };
}

describe("docs cache invalidation worker", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("completes a task only after its purge succeeds", async () => {
    const state = fixture([{ ...task, hostname: "docs.example.com" }]);
    const worker = new DocsCacheInvalidationWorker(state.store, {
      invalidate: async (input) => {
        expect(state.completed).toEqual([]);
        expect(input).toEqual({
          siteId: "site-1",
          hostname: "docs.example.com",
        });
      },
    });
    expect(await worker.process()).toEqual({ completed: 1, failed: 0 });
    expect(state.completed).toEqual(["task-1"]);
  });

  test.each([
    { attempts: 1, delay: 30 },
    { attempts: 2, delay: 60 },
    { attempts: 20, delay: 3600 },
  ])(
    "retains a failed task with backoff after attempt $attempts",
    async ({ attempts, delay }) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const state = fixture([{ ...task, attempts }]);
      const worker = new DocsCacheInvalidationWorker(state.store, {
        invalidate: async () => {
          throw new Error("upstream error");
        },
      });
      expect(await worker.process()).toEqual({ completed: 0, failed: 1 });
      expect(state.completed).toEqual([]);
      expect(state.failed).toEqual([
        { id: "task-1", error: "purge_failed", delay },
      ]);
    },
  );

  test("retains work when the binding is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = fixture();
    await new DocsCacheInvalidationWorker(state.store, undefined).process();
    expect(state.failed[0]?.error).toBe("binding_missing");
    expect(state.completed).toEqual([]);
  });

  test("times out a stalled purge without a late completion acknowledgement", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = fixture();
    let finish: (() => void) | undefined;
    const pending = new DocsCacheInvalidationWorker(state.store, {
      invalidate: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    }).process();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ completed: 0, failed: 1 });
    finish?.();
    await Promise.resolve();
    expect(state.failed[0]?.error).toBe("purge_timeout");
    expect(state.completed).toEqual([]);
  });

  test("continues to the next task after a failed purge", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = fixture([task, { ...task, id: "task-2", siteId: "site-2" }]);
    const worker = new DocsCacheInvalidationWorker(state.store, {
      invalidate: async ({ siteId }) => {
        if (siteId === "site-1") throw new Error("failed");
      },
    });
    expect(await worker.process()).toEqual({ completed: 1, failed: 1 });
    expect(state.completed).toEqual(["task-2"]);
  });
});
