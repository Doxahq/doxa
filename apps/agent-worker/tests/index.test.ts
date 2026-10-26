import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {},
  DurableObject: class DurableObject {},
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));

import worker, { createInternalApiAdapter, runGenerationWatchdog } from "../src/index";

describe("agent worker queue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("acks after admitting a durable workflow instance", async () => {
    const message = createMessage();
    const env = createEnv();

    await worker.queue({ messages: [message] } as never, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.GENERATION_WORKFLOW.create).toHaveBeenCalledWith({
      id: "11111111-1111-4111-8111-111111111111",
      params: { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1", userId: "user-1" },
      // A failed run stays inspectable longer than a successful one.
      retention: { successRetention: "7 days", errorRetention: "30 days" },
    });
  });

  test("acks duplicate queue delivery when the workflow instance already exists", async () => {
    const message = createMessage();
    const env = createEnv();
    env.GENERATION_WORKFLOW.create = vi.fn(async () => {
      throw new Error("Workflow instance already exists");
    });

    await worker.queue({ messages: [message] } as never, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  test("confirms an existing workflow when the duplicate error text is opaque", async () => {
    const message = createMessage();
    const env = createEnv();
    env.GENERATION_WORKFLOW.create = vi.fn(async () => {
      throw new Error("workflow create conflict");
    });
    env.GENERATION_WORKFLOW.get = vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      pause: vi.fn(),
      resume: vi.fn(),
      terminate: vi.fn(),
      restart: vi.fn(),
      status: vi.fn(async () => ({ status: "running" as const })),
      sendEvent: vi.fn(),
    } as unknown as WorkflowInstance));

    await worker.queue({ messages: [message] } as never, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  test("retries workflow admission infrastructure errors", async () => {
    const message = createMessage();
    const env = createEnv();
    env.GENERATION_WORKFLOW.create = vi.fn(async () => {
      throw new Error("workflow service unavailable");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await worker.queue({ messages: [message] } as never, env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  test("acks queued messages without waking the container while generation is paused", async () => {
    const message = createMessage();
    const env = createEnv();
    env.API.getGenerationControl = vi.fn(async () => ({
      status: "paused" as const,
      reason: "maintenance",
      updatedByUserId: "admin-1",
      updatedAt: "2026-06-16T00:00:00.000Z",
    }));

    await worker.queue({ messages: [message] } as never, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.GENERATION_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.API.markJobCancelled).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "Generation is paused: maintenance");
  });
});

describe("agent worker watchdog", () => {
  test("cleans up stale queued and running jobs without requiring container destroy success", async () => {
    const env = createEnv();
    env.API.listStaleGenerationJobs = vi.fn(async () => [
      {
        id: "11111111-1111-4111-8111-111111111111",
        projectId: "project-1",
        status: "queued" as const,
        docsVersionId: null,
        errorMessage: null,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        projectName: "Queued",
        projectSlug: "queued",
        repositoryFullName: "doxahq/queued",
        latestEvent: null,
        elapsedSeconds: 700,
        isStale: true,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        projectId: "project-2",
        status: "running" as const,
        docsVersionId: null,
        errorMessage: null,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        projectName: "Running",
        projectSlug: "running",
        repositoryFullName: "doxahq/running",
        latestEvent: null,
        elapsedSeconds: 1300,
        isStale: true,
      },
    ]);
    env.AGENT_CONTAINER = {
      fetch: vi.fn(async () => Response.json({ error: "gone" }, { status: 404 })),
    };

    await runGenerationWatchdog(env);

    expect(env.API.markJobCancelled).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Queued generation cancelled by watchdog after waiting too long.",
    );
    expect(env.API.markJobFailed).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "Running generation marked failed by watchdog after timing out.",
    );
    expect(env.AGENT_CONTAINER.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("createInternalApiAdapter", () => {
  test("forwards generation calls to the service binding RPC shape", async () => {
    const api = {
      getGenerationContext: vi.fn(async () => null),
      getGenerationExecutionContext: vi.fn(async () => null),
      getGenerationDatabaseCompatibility: vi.fn(async () => ({
        ready: true,
        missingColumns: [],
      })),
      getCurrentChangeProposalState: vi.fn(async () => null),
      createInstallationAccessToken: vi.fn(async () => "install-token"),
      createRepositoryReadToken: vi.fn(async () => "install-token"),
      markJobRunning: vi.fn(async () => undefined),
      markJobFailed: vi.fn(async () => undefined),
      markJobCancelled: vi.fn(async () => undefined),
      markJobSuperseded: vi.fn(async () => undefined),
      isJobActive: vi.fn(async () => true),
      getGenerationResumedAt: vi.fn(async () => null),
      getGenerationControl: vi.fn(async () => ({
        status: "enabled" as const,
        reason: null,
        updatedByUserId: null,
        updatedAt: null,
      })),
      listStaleGenerationJobs: vi.fn(async () => []),
      addJobEvent: vi.fn(async () => ({
        id: "event-1",
        jobId: "11111111-1111-4111-8111-111111111111",
        sequence: 1,
        source: "worker" as const,
        type: "clone_started",
        message: "Clone started.",
        data: null,
        createdAt: "2026-06-14T00:00:00.000Z",
      })),
      recordGenerationUsage: vi.fn(async () => undefined),
      recordGenerationDiagnostic: vi.fn(async () => undefined),
      getGenerationUsageSummary: vi.fn(async () => null),
      deleteExpiredGenerationObservability: vi.fn(async () => ({
        diagnostics: 0,
      })),
      publishJobOutput: vi.fn(async () => ({ versionId: "version-1" })),
      completeJobOutput: vi.fn(async () => ({
        versionId: "11111111-1111-4111-8111-111111111111",
        previewUrl: null,
      })),
      createReviewRun: vi.fn(async () => ({
        externalRunId: "9001",
        outcome: "created" as const,
      })),
      updateReviewRun: vi.fn(async () => ({
        externalRunId: "9001",
        outcome: "updated" as const,
      })),
      resolveDocsSite: vi.fn(async () => null),
      resolveDocsProject: vi.fn(async () => null),
      resolveDocsHost: vi.fn(async () => null),
      readDocsArtifact: vi.fn(async () => null),
    };
    const adapter = createInternalApiAdapter(api);

    await adapter.addJobEvent(
      "11111111-1111-4111-8111-111111111111",
      "clone_started",
      "Clone started.",
      { repo: "doxahq/doxa" },
      "container",
    );
    await adapter.publishJobOutput({
      jobId: "11111111-1111-4111-8111-111111111111",
      artifactPrefix: "sites/site-1/versions/version-1",
      manifestPath: "sites/site-1/versions/version-1/manifest.json",
    });

    expect(api.addJobEvent).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      type: "clone_started",
      message: "Clone started.",
      data: { repo: "doxahq/doxa" },
      source: "container",
    });
    expect(api.publishJobOutput).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      jobId: "11111111-1111-4111-8111-111111111111",
      artifactPrefix: "sites/site-1/versions/version-1",
      manifestPath: "sites/site-1/versions/version-1/manifest.json",
    });
  });
});

function createMessage() {
  return {
    body: { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1", userId: "user-1" },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createEnv(): Parameters<typeof worker.queue>[1] {
  return {
    API: {
      resolveDocsSite: vi.fn(async () => null),
      resolveDocsProject: vi.fn(async () => null),
      resolveDocsHost: vi.fn(async () => null),
      readDocsArtifact: vi.fn(async () => null),
      getGenerationContext: vi.fn(async () => null),
      getGenerationExecutionContext: vi.fn(async () => null),
      getGenerationDatabaseCompatibility: vi.fn(async () => ({
        ready: true,
        missingColumns: [],
      })),
      getCurrentChangeProposalState: vi.fn(async () => null),
      createInstallationAccessToken: vi.fn(async () => "install-token"),
      createRepositoryReadToken: vi.fn(async () => "install-token"),
      markJobRunning: vi.fn(async () => undefined),
      markJobFailed: vi.fn(async () => undefined),
      markJobCancelled: vi.fn(async () => undefined),
      markJobSuperseded: vi.fn(async () => undefined),
      isJobActive: vi.fn(async () => true),
      getGenerationResumedAt: vi.fn(async () => null),
      getGenerationControl: vi.fn(async () => ({
        status: "enabled" as const,
        reason: null,
        updatedByUserId: null,
        updatedAt: null,
      })),
      listStaleGenerationJobs: vi.fn(async () => []),
      addJobEvent: vi.fn(async () => ({
        id: "event-1",
        jobId: "11111111-1111-4111-8111-111111111111",
        sequence: 1,
        source: "api" as const,
        type: "test",
        message: "test",
        data: null,
        createdAt: "2026-06-14T00:00:00.000Z",
      })),
      recordGenerationUsage: vi.fn(async () => undefined),
      recordGenerationDiagnostic: vi.fn(async () => undefined),
      getGenerationUsageSummary: vi.fn(async () => null),
      deleteExpiredGenerationObservability: vi.fn(async () => ({
        diagnostics: 0,
      })),
      publishJobOutput: vi.fn(async () => ({ versionId: "version-1" })),
      completeJobOutput: vi.fn(async () => ({
        versionId: "11111111-1111-4111-8111-111111111111",
        previewUrl: null,
      })),
      createReviewRun: vi.fn(async () => ({
        externalRunId: "9001",
        outcome: "created" as const,
      })),
      updateReviewRun: vi.fn(async () => ({
        externalRunId: "9001",
        outcome: "updated" as const,
      })),
    },
    DOCS_BUCKET: {
      put: vi.fn(async () => undefined),
    } as unknown as R2Bucket,
    GENERATION_WORKFLOW: {
      create: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" })),
    } as unknown as Workflow<Parameters<typeof worker.queue>[0]["messages"][number]["body"]>,
    AGENT_CONTAINER: {
      fetch: vi.fn(async () => Response.json({ ok: true })),
    },
    AGENT_CONTAINER_URL: "http://agent-container.test",
    OPENROUTER_API_KEY: "openrouter-key",
    DOXA_AGENT_MODEL: "openai/gpt-4.1-mini",
    DOXA_GENERATION_PROFILE: "fast-mvp",
    DOXA_AGENT_PAGE_CONCURRENCY: "6",
    GENERATION_TIMEOUT_MS: "120000",
    GENERATION_IDLE_TIMEOUT_MS: "90000",
  };
}
