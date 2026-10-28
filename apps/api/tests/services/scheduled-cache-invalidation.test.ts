import { describe, expect, test, vi } from "vitest";

const pending = vi.hoisted(() => ({
  generations: vi.fn(),
  prerenders: vi.fn(),
  purges: vi.fn(),
  hostnameMaps: vi.fn(),
  collections: vi.fn(),
  approvalSweeps: vi.fn(),
  domainChecks: vi.fn(),
  mergeRuns: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../../src/services/doxabot/queue-outbox", () => ({
  DoxabotQueueOutboxPublisher: {
    fromEnv: () => ({ publishPending: pending.generations }),
  },
}));
vi.mock("../../src/services/docs-cache-invalidation-monitoring", () => ({
  DocsCacheInvalidationMaintenance: {
    fromEnv: () => ({ run: pending.purges }),
  },
}));
vi.mock("../../src/services/docs-hostname-map", () => ({
  DocsHostnameMapReconciler: {
    fromEnv: () => ({ run: pending.hostnameMaps }),
  },
}));
vi.mock("../../src/services/docs-prerender-tasks", () => ({
  DocsPrerenderTaskMaintenance: {
    fromEnv: () => ({ run: pending.prerenders }),
  },
}));
vi.mock("../../src/services/storage-gc", () => ({
  createStorageGarbageCollector: () => ({ run: pending.collections }),
}));

vi.mock("../../src/services/docs-domain-status-checks", () => ({
  DocsDomainStatusChecks: {
    fromEnv: () => ({ run: pending.domainChecks }),
  },
}));

vi.mock("../../src/services/doxabot/merge-generations", () => ({
  MergeGenerationScheduler: {
    fromEnv: () => ({ run: pending.mergeRuns }),
  },
}));

vi.mock("../../src/services/agent-actions/action-runtime", () => ({
  createAgentActionRuntime: () => ({ sweeper: { run: pending.approvalSweeps } }),
}));

import worker from "../../src/index";

describe("scheduled cache invalidation", () => {
  test("runs all durable maintenance jobs when generation delivery fails", async () => {
    pending.generations.mockRejectedValue(new Error("queue unavailable"));
    pending.purges.mockResolvedValue({ completed: 1, failed: 0 });
    pending.hostnameMaps.mockResolvedValue({ slot: 3, due: 1, stored: 1, deleted: 0 });
    pending.prerenders.mockResolvedValue({ dispatched: 2 });
    pending.collections.mockResolvedValue({ collected: 1 });
    pending.approvalSweeps.mockResolvedValue({ expired: 0, removedKinds: 0, interrupted: 0, stale: 0 });
    pending.domainChecks.mockResolvedValue({ checked: 3, failed: 0 });
    pending.mergeRuns.mockResolvedValue(0);
    const background: Promise<unknown>[] = [];
    await worker.scheduled(
      {} as never,
      {} as never,
      {
        waitUntil: (promise: Promise<unknown>) => {
          background.push(promise);
        },
      } as never,
    );
    expect(await Promise.allSettled(background)).toEqual([
      { status: "rejected", reason: expect.any(Error) },
      { status: "fulfilled", value: { completed: 1, failed: 0 } },
      { status: "fulfilled", value: { slot: 3, due: 1, stored: 1, deleted: 0 } },
      { status: "fulfilled", value: { dispatched: 2 } },
      { status: "fulfilled", value: { collected: 1 } },
      { status: "fulfilled", value: { checked: 3, failed: 0 } },
      {
        status: "fulfilled",
        value: { expired: 0, removedKinds: 0, interrupted: 0, stale: 0 },
      },
      { status: "fulfilled", value: 0 },
    ]);
    expect(pending.purges).toHaveBeenCalledOnce();
    expect(pending.hostnameMaps).toHaveBeenCalledOnce();
    expect(pending.prerenders).toHaveBeenCalledOnce();
    expect(pending.collections).toHaveBeenCalledOnce();
    expect(pending.approvalSweeps).toHaveBeenCalledOnce();
    expect(pending.domainChecks).toHaveBeenCalledOnce();
    expect(pending.mergeRuns).toHaveBeenCalledOnce();
  });
});
