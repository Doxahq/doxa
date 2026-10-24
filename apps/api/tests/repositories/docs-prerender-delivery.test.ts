import type { PrerenderTaskPayload } from "@doxahq/contracts/docs-prerender-tasks";
import { describe, expect, test, vi } from "vitest";

import { dispatchDocsPrerenderTasks } from "../../src/repositories/docs-prerender-delivery";

const task = {
  taskId: "63de8404-a0d7-48bd-8827-1f9b21995098",
  claimToken: "claim-token-1234567890",
  attempt: 1,
  reason: "generation",
  resolution: {
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "demo",
    publishedVersionId: "published-1",
    artifactPrefix: "sites/site-1/versions/source-1",
    manifestPath: "sites/site-1/versions/source-1/manifest.json",
    accessPolicy: "public",
  },
  identity: {
    siteId: "site-1",
    renderId: "d".repeat(64),
    artifactIdentity: "a".repeat(64),
    rendererReleaseId: "b".repeat(64),
    renderContextId: "c".repeat(64),
    artifactPrefix: "sites/site-1/versions/source-1",
    sourceManifestPath: "sites/site-1/versions/source-1/manifest.json",
    sourceArtifactVersion: "source-1",
    trustedRequestOrigin: "https://demo.doxa.page",
  },
} satisfies PrerenderTaskPayload;

describe("dispatchDocsPrerenderTasks", () => {
  test("keeps a failed dispatch in the durable retry lifecycle", async () => {
    const failDispatch = vi.fn(async () => ({ status: "accepted" as const }));
    const store = {
      claim: vi.fn(async () => [task]),
      failDispatch,
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dispatchDocsPrerenderTasks(store, {
        start: vi.fn(async () => {
          throw new Error("queue unavailable\nsecret-like-detail");
        }),
      }),
    ).resolves.toEqual({ claimed: 1, dispatched: 0, dispatchFailed: 1 });
    expect(failDispatch).toHaveBeenCalledWith(task, expect.any(Error));
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("docs_prerender_dispatch_failed"),
    );
    errorLog.mockRestore();
  });

  test("does not claim work when the queue binding is absent", async () => {
    const store = {
      claim: vi.fn(async () => [task]),
      failDispatch: vi.fn(async () => ({ status: "accepted" as const })),
    };

    await expect(
      dispatchDocsPrerenderTasks(store, undefined),
    ).resolves.toEqual({ claimed: 0, dispatched: 0, dispatchFailed: 0 });
    expect(store.claim).not.toHaveBeenCalled();
  });
});
