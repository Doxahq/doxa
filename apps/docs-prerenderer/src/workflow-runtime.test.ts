import { describe, expect, it, vi } from "vitest";

import type { PrerenderTaskPayload } from "./task-contract";
import {
  PrerenderTaskObsoleteError,
  PrerenderPermanentError,
  PrerenderWorkflowRunner,
  type PrerenderTaskApi,
  type PrerenderWorkflowStep,
} from "./workflow-runtime";

const identity = {
  schemaVersion: 1 as const,
  siteId: "site-1",
  artifactIdentity: "a".repeat(64),
  artifactPrefix: "sites/site-1/versions/source-1",
  sourceManifestPath: "sites/site-1/versions/source-1/manifest.json",
  sourceArtifactVersion: "source-1",
  rendererReleaseId: "b".repeat(64),
  renderContextId: "c".repeat(64),
  renderId: "d".repeat(64),
  trustedRequestOrigin: "https://docs.example.com",
};

const payload: PrerenderTaskPayload = {
  taskId: "63de8404-a0d7-48bd-8827-1f9b21995098",
  claimToken: "claim-token-1234567890",
  attempt: 1,
  reason: "generation",
  identity,
  resolution: {
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "demo",
    publishedVersionId: "published-version-1",
    artifactPrefix: "sites/site-1/versions/source-1",
    manifestPath: "sites/site-1/versions/source-1/manifest.json",
    accessPolicy: "public",
  },
};

function createStep(): PrerenderWorkflowStep {
  return {
    validateTask: vi.fn(async (callback) => callback()),
    renderAndCommit: vi.fn(async (callback) => callback()),
    completeTask: vi.fn(async (callback) => callback()),
  };
}

const executionInput = {
  identity,
  renderer: {
    getPlan: async () => [],
    prepare: async () => ({ type: "not_found" as const }),
    render: async () => new Response(),
  },
  bucket: {
    get: async () => null,
    put: async () => ({ etag: "unused" }),
  },
  now: () => new Date("2026-09-19T20:00:00.000Z"),
};

function createApi(
  overrides: Partial<PrerenderTaskApi> = {},
): PrerenderTaskApi {
  return {
    validate: vi.fn(async () => ({ status: "active" as const })),
    heartbeat: vi.fn(async () => ({ status: "accepted" as const })),
    complete: vi.fn(async () => ({ status: "accepted" as const })),
    fail: vi.fn(async () => ({ status: "accepted" as const })),
    ...overrides,
  };
}

describe("PrerenderWorkflowRunner", () => {
  it("revalidates the lease, heartbeats bounded progress, and completes with the claim token", async () => {
    const api = createApi();
    const execute = vi.fn(async (input) => {
      await input.onProgress?.({ completedRoutes: 4, totalRoutes: 6 });
      await input.onProgress?.({ completedRoutes: 6, totalRoutes: 6 });
      return { status: "committed" as const, routeCount: 6 };
    });
    const runner = new PrerenderWorkflowRunner({
      api,
      execute,
      createExecutionInput: () => executionInput,
    });

    await expect(runner.run(payload, createStep())).resolves.toEqual({
      status: "committed",
      routeCount: 6,
    });
    expect(api.validate).toHaveBeenCalledWith({
      taskId: payload.taskId,
      claimToken: payload.claimToken,
      identity: payload.identity,
    });
    expect(api.heartbeat).toHaveBeenNthCalledWith(1, {
      taskId: payload.taskId,
      claimToken: payload.claimToken,
      completedRoutes: 4,
      totalRoutes: 6,
    });
    expect(api.complete).toHaveBeenCalledWith({
      taskId: payload.taskId,
      claimToken: payload.claimToken,
      routeCount: 6,
      outcome: "committed",
    });
    expect(api.fail).not.toHaveBeenCalled();
  });

  it("does not render an obsolete or stolen task", async () => {
    const api = createApi({
      validate: vi.fn(async () => ({ status: "obsolete" as const })),
    });
    const execute = vi.fn();
    const runner = new PrerenderWorkflowRunner({
      api,
      execute,
      createExecutionInput: () => executionInput,
    });

    await expect(runner.run(payload, createStep())).rejects.toBeInstanceOf(
      PrerenderTaskObsoleteError,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it("reports a sanitized bounded failure through the same claim token", async () => {
    const api = createApi();
    const runner = new PrerenderWorkflowRunner({
      api,
      execute: vi.fn(async () => {
        throw new Error(`storage failed ${"x".repeat(700)}`);
      }),
      createExecutionInput: () => executionInput,
    });

    await expect(runner.run(payload, createStep())).rejects.toThrow(
      "storage failed",
    );
    expect(api.fail).toHaveBeenCalledWith({
      taskId: payload.taskId,
      claimToken: payload.claimToken,
      errorCode: "prerender_failed",
      errorMessage: expect.stringMatching(/^storage failed x+$/),
      retryable: true,
    });
    const failure = vi.mocked(api.fail).mock.calls[0]?.[0];
    expect(failure?.errorMessage.length).toBeLessThanOrEqual(500);
  });

  it("reports unsupported output as a permanent failure", async () => {
    const api = createApi();
    const runner = new PrerenderWorkflowRunner({
      api,
      execute: vi.fn(async () => {
        throw new PrerenderPermanentError("unsupported route data");
      }),
      createExecutionInput: () => executionInput,
    });

    await expect(runner.run(payload, createStep())).rejects.toThrow(
      "unsupported route data",
    );
    expect(api.fail).toHaveBeenCalledWith({
      taskId: payload.taskId,
      claimToken: payload.claimToken,
      errorCode: "unsupported_output",
      errorMessage: "unsupported route data",
      retryable: false,
    });
  });
});
