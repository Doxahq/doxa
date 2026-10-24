import type { PrerenderTaskPayload } from "@doxahq/contracts/docs-prerender-tasks";
import { describe, expect, test, vi } from "vitest";

import { DocsPrerenderTaskMaintenance } from "../../src/services/docs-prerender-tasks";
import type { PrerenderManifestCandidate } from "../../src/repositories/docs-prerender-tasks";

const identity = {
  siteId: "site-1",
  renderId: "d".repeat(64),
  artifactIdentity: "a".repeat(64),
  rendererReleaseId: "b".repeat(64),
  renderContextId: "c".repeat(64),
  artifactPrefix: "sites/site-1/versions/source-1",
  sourceManifestPath: "sites/site-1/versions/source-1/manifest.json",
  sourceArtifactVersion: "source-1",
  trustedRequestOrigin: "https://demo.doxa.page",
};

const task = {
  taskId: "63de8404-a0d7-48bd-8827-1f9b21995098",
  claimToken: "claim-token-1234567890",
  attempt: 1,
  reason: "reconciliation",
  resolution: {
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "demo",
    publishedVersionId: "published-1",
    artifactPrefix: identity.artifactPrefix,
    manifestPath: identity.sourceManifestPath,
    accessPolicy: "public",
  },
  identity,
} satisfies PrerenderTaskPayload;

describe("DocsPrerenderTaskMaintenance", () => {
  test("reopens a completed task when its manifest is missing", async () => {
    const store = createStore();
    store.listManifestCandidates.mockResolvedValue([
      { taskId: task.taskId, identity },
    ]);
    store.reopenMissingOutput.mockResolvedValue("reopened");
    store.claim.mockResolvedValue([task]);
    const queue = {
      inspect: vi.fn(async () => ({ status: "missing" as const })),
      start: vi.fn(async () => ({
        status: "accepted" as const,
        workflowId: "workflow-1",
      })),
    };

    const result = await new DocsPrerenderTaskMaintenance(
      store,
      queue,
    ).run();

    expect(store.reopenMissingOutput).toHaveBeenCalledWith({
      taskId: task.taskId,
      identity,
    });
    expect(queue.start).toHaveBeenCalledWith(task);
    expect(result).toMatchObject({
      manifestsInspected: 1,
      manifestsReopened: 1,
      claimed: 1,
      dispatched: 1,
    });
  });

  test("touches a complete manifest without reopening its task", async () => {
    const store = createStore();
    const candidate = { taskId: task.taskId, identity };
    store.listManifestCandidates.mockResolvedValue([candidate]);
    const queue = {
      inspect: vi.fn(async () => ({ status: "complete" as const })),
      start: vi.fn(),
    };

    await new DocsPrerenderTaskMaintenance(store, queue).run();

    expect(store.markManifestVerified).toHaveBeenCalledWith(candidate);
    expect(store.reopenMissingOutput).not.toHaveBeenCalled();
  });
});

function createStore() {
  return {
    reconcile: vi.fn(async () => ({ created: 0, obsoleted: 0 })),
    listManifestCandidates: vi.fn<
      () => Promise<PrerenderManifestCandidate[]>
    >(async () => []),
    markManifestVerified: vi.fn(async () => undefined),
    reopenMissingOutput: vi.fn<
      () => Promise<"reopened" | "stale">
    >(async () => "stale"),
    claim: vi.fn<() => Promise<PrerenderTaskPayload[]>>(async () => []),
    failDispatch: vi.fn(async () => ({ status: "accepted" as const })),
    readHealth: vi.fn(async () => ({
      pendingCount: 0,
      runningCount: 0,
      failedCount: 0,
      exhaustedCount: 0,
      oldestTaskAgeSeconds: 0,
    })),
  };
}
