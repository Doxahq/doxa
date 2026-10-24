import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  WorkflowEntrypoint: class WorkflowEntrypoint {},
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));

import worker, {
  createPrerenderWorkflowId,
  isWorkflowAlreadyExistsError,
  PrerenderQueue,
  validateTaskForRelease,
} from "./index";

const release = "b".repeat(64);
const task = {
  taskId: "63de8404-a0d7-48bd-8827-1f9b21995098",
  claimToken: "claim-token-1234567890",
  attempt: 2,
  reason: "repair",
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
    rendererReleaseId: release,
    renderContextId: "c".repeat(64),
    artifactPrefix: "sites/site-1/versions/source-1",
    sourceManifestPath: "sites/site-1/versions/source-1/manifest.json",
    sourceArtifactVersion: "source-1",
    trustedRequestOrigin: "https://docs.example.com",
  },
};

describe("private pre-render worker", () => {
  it("has no public rendering or task route", async () => {
    const response = await worker.fetch();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts only tasks pinned to the server-owned renderer release", () => {
    expect(validateTaskForRelease(task, release)).toEqual(task);
    expect(() => validateTaskForRelease(task, "e".repeat(64))).toThrow(
      "does not match",
    );
  });

  it("uses the durable attempt identity without exposing the claim token", () => {
    const workflowId = createPrerenderWorkflowId(task);

    expect(workflowId).toBe(
      "docs-prerender-63de8404-a0d7-48bd-8827-1f9b21995098-attempt-2",
    );
    expect(workflowId).not.toContain(task.claimToken);
  });

  it("deletes only the objects of the named render", async () => {
    const list = vi.fn(async () => ({
      objects: [{ key: `render/v1/sites/site-1/renders/${"d".repeat(64)}/manifest.json` }],
      truncated: false,
    }));
    const remove = vi.fn(async () => undefined);
    const queue = new PrerenderQueue(undefined as never, {
      DOCS_RENDERED_BUCKET: { list, delete: remove },
    } as never);

    await expect(
      queue.collectRender({ siteId: "site-1", renderId: "d".repeat(64) }),
    ).resolves.toEqual({ deletedObjects: 1, status: "complete" });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: `render/v1/sites/site-1/renders/${"d".repeat(64)}/`,
      }),
    );
  });

  it("rejects a collection request with an unknown field or bad identity", async () => {
    const queue = new PrerenderQueue(undefined as never, {
      DOCS_RENDERED_BUCKET: { list: vi.fn(), delete: vi.fn() },
    } as never);

    await expect(
      queue.collectRender({
        siteId: "site-1",
        renderId: "d".repeat(64),
        prefix: "render/v1/sites/other-site/",
      }),
    ).rejects.toThrow();
    await expect(
      queue.collectRender({ siteId: "../escape", renderId: "d".repeat(64) }),
    ).rejects.toThrow();
  });

  it("recognizes duplicate durable workflow admission", () => {
    expect(
      isWorkflowAlreadyExistsError(
        new Error("Workflow instance already exists"),
      ),
    ).toBe(true);
    expect(isWorkflowAlreadyExistsError(new Error("service unavailable"))).toBe(
      false,
    );
  });
});
