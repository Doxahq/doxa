import { afterEach, describe, expect, test, vi } from "vitest";
import { emptyPageDependencyState } from "@doxahq/contracts";
import {
  callGenerationStage,
  readGenerationStageStream,
} from "../src/workflow-stage-client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflow stage stream", () => {
  test("sends combined planning requests to the plan route", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      new Response([
        JSON.stringify({
          kind: "stage_result",
          result: {
            stage: "plan",
            analysisCheckpoint: "{}",
            structureCheckpoint: "{\"sections\":[]}",
            pageIds: ["overview"],
            pageInputHashes: { overview: "a".repeat(64) },
            routeRegistryHash: "b".repeat(64),
            navigation: {
              sections: [
                { slug: "default", items: ["default/overview.md"] },
              ],
            },
          },
        }),
        "",
      ].join("\n"), {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
        },
      })
    );

    await expect(callGenerationStage({
      jobId: "11111111-1111-4111-8111-111111111111",
      stage: "plan",
      repositoryFullName: "doxa/example",
      installationAccessToken: "installation-token",
      modelProvider: "openrouter",
      modelApiKey: "openrouter-key",
      generationProfile: "fast-mvp",
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "example",
      projectName: "Example",
    }, {
      agentContainerUrl: "https://agent-container.test",
      idleTimeoutMs: 1_000,
      fetch: fetch as typeof globalThis.fetch,
    })).resolves.toMatchObject({ stage: "plan" });

    expect(fetch).toHaveBeenCalledWith(
      "https://agent-container.test/stages/plan/stream",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("returns the checkpoint result and forwards activity records", async () => {
    const onHeartbeat = vi.fn();
    const onEvent = vi.fn();
    const response = new Response([
      JSON.stringify({ kind: "heartbeat", elapsedMs: 1000 }),
      JSON.stringify({
        kind: "event",
        event: { source: "container", type: "analysis_started", message: "Analyzing." },
      }),
      JSON.stringify({
        kind: "stage_result",
        result: { stage: "analysis", checkpoint: "{\"projectName\":\"FlagForge\"}" },
      }),
      "",
    ].join("\n"), { headers: { "content-type": "application/x-ndjson" } });

    await expect(readGenerationStageStream(response, { onHeartbeat, onEvent })).resolves.toEqual({
      stage: "analysis",
      checkpoint: "{\"projectName\":\"FlagForge\"}",
    });
    expect(onHeartbeat).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "analysis_started" }));
  });

  test("routes usage and diagnostics through internal callbacks only", async () => {
    const onEvent = vi.fn();
    const onUsage = vi.fn();
    const onDiagnostic = vi.fn();
    const jobId = "11111111-1111-4111-8111-111111111111";
    const stageExecutionId = "22222222-2222-4222-8222-222222222222";
    const response = new Response([
      JSON.stringify({
        kind: "usage",
        record: {
          callId: "33333333-3333-4333-8333-333333333333",
          jobId,
          stageExecutionId,
          stage: "write",
          operation: "page_write",
          modelRole: "writer",
          model: "moonshotai/kimi-k2.6:nitro",
          pageId: "overview",
          pageTitle: "Overview",
          pageRetry: 0,
          attempt: 1,
          iteration: 1,
          providerGenerationId: "generation-1",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          costUsd: "0.01",
          promptCostUsd: null,
          completionCostUsd: null,
          upstreamCostUsd: null,
          durationMs: 100,
          finishReason: "stop",
          recordedAt: "2026-07-25T12:00:00.000Z",
        },
      }),
      JSON.stringify({
        kind: "diagnostic",
        diagnostic: {
          diagnosticId: "44444444-4444-4444-8444-444444444444",
          jobId,
          stageExecutionId,
          pageId: "overview",
          pageTitle: "Overview",
          pageRetry: 0,
          writerAttempt: 1,
          attempt: 1,
          maxAttempts: 3,
          model: "moonshotai/kimi-k2.6:nitro",
          rule: "unexpected-character",
          message: "Unexpected character before name",
          line: 12,
          column: 8,
          snippet: "Latency is <25 ms.",
          draftSha256: "a".repeat(64),
          draft: "Latency is <25 ms.",
          draftTruncated: false,
          repairKind: "model_patch",
          repairSucceeded: true,
          rejectionReason: null,
          validationIssueCodes: [],
          createdAt: "2026-07-25T12:00:01.000Z",
        },
      }),
      JSON.stringify({
        kind: "stage_result",
        result: { stage: "analysis", checkpoint: "{}" },
      }),
      "",
    ].join("\n"));

    await readGenerationStageStream(response, {
      onEvent,
      onUsage,
      onDiagnostic,
    });

    expect(onUsage).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("continues to the stage result when usage persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = new Response([
      JSON.stringify({
        kind: "usage",
        record: {
          callId: "33333333-3333-4333-8333-333333333333",
          jobId: "11111111-1111-4111-8111-111111111111",
          stageExecutionId: "22222222-2222-4222-8222-222222222222",
          stage: "write",
          operation: "page_write",
          modelRole: "writer",
          model: "moonshotai/kimi-k2.6:nitro",
          pageId: "overview",
          pageTitle: "Overview",
          pageRetry: 0,
          attempt: 1,
          iteration: 1,
          providerGenerationId: "generation-1",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          costUsd: "0.01",
          promptCostUsd: null,
          completionCostUsd: null,
          upstreamCostUsd: null,
          durationMs: 100,
          finishReason: "stop",
          recordedAt: "2026-07-25T12:00:00.000Z",
        },
      }),
      JSON.stringify({
        kind: "stage_result",
        result: { stage: "analysis", checkpoint: "{}" },
      }),
      "",
    ].join("\n"));

    await expect(readGenerationStageStream(response, {
      onUsage: async () => {
        throw new Error("usage database unavailable");
      },
    })).resolves.toEqual({ stage: "analysis", checkpoint: "{}" });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      "generation_observability_persistence_failed",
    ));
  });

  test("continues to the stage result when diagnostic persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = new Response([
      JSON.stringify({
        kind: "diagnostic",
        diagnostic: {
          diagnosticId: "44444444-4444-4444-8444-444444444444",
          jobId: "11111111-1111-4111-8111-111111111111",
          stageExecutionId: "22222222-2222-4222-8222-222222222222",
          pageId: "overview",
          pageTitle: "Overview",
          pageRetry: 0,
          writerAttempt: 1,
          attempt: 1,
          maxAttempts: 3,
          model: "moonshotai/kimi-k2.6:nitro",
          rule: "unexpected-character",
          message: "Unexpected character before name",
          line: 12,
          column: 8,
          snippet: "Latency is <25 ms.",
          draftSha256: "a".repeat(64),
          draft: "Latency is <25 ms.",
          draftTruncated: false,
          repairKind: "model_patch",
          repairSucceeded: true,
          rejectionReason: null,
          validationIssueCodes: [],
          createdAt: "2026-07-25T12:00:01.000Z",
        },
      }),
      JSON.stringify({
        kind: "stage_result",
        result: { stage: "analysis", checkpoint: "{}" },
      }),
      "",
    ].join("\n"));

    await expect(readGenerationStageStream(response, {
      onDiagnostic: async () => {
        throw new Error("diagnostic database unavailable");
      },
    })).resolves.toEqual({ stage: "analysis", checkpoint: "{}" });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      "generation_observability_persistence_failed",
    ));
  });

  test("keeps all page checkpoints when diagnostic persistence fails after five pages", async () => {
    const pages = [
      "authentication",
      "overview",
      "installation",
      "configuration",
      "self-hosting",
      "quickstart",
    ].map((id) => ({
      id,
      title: id,
      route: `/${id}`,
      navigationPath: `default/${id}.md`,
      content: `# ${id}\n`,
      dependencies: emptyPageDependencyState(),
      contentHash: "a".repeat(64),
      pageInputHash: "b".repeat(64),
    }));
    const diagnostic = {
      kind: "diagnostic",
      diagnostic: {
        diagnosticId: "44444444-4444-4444-8444-444444444444",
        jobId: "11111111-1111-4111-8111-111111111111",
        stageExecutionId: "22222222-2222-4222-8222-222222222222",
        pageId: "quickstart",
        pageTitle: "Quickstart",
        pageRetry: 0,
        writerAttempt: 1,
        attempt: 1,
        maxAttempts: 3,
        model: "moonshotai/kimi-k2.6:nitro",
        rule: "unexpected-character",
        message: "Unexpected character before name",
        line: 12,
        column: 8,
        snippet: "Latency is <25 ms.",
        draftSha256: "a".repeat(64),
        draft: "Latency is <25 ms.",
        draftTruncated: false,
        repairKind: "model_patch",
        repairSucceeded: true,
        rejectionReason: null,
        validationIssueCodes: [],
        createdAt: "2026-07-25T12:00:01.000Z",
      },
    };
    const records = [
      ...pages.slice(0, 5).map((page) => ({ kind: "page_checkpoint", page })),
      diagnostic,
      { kind: "page_checkpoint", page: pages[5] },
      { kind: "stage_result", result: { stage: "write", pages } },
    ];
    const response = new Response(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const checkpointedPageIds: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(readGenerationStageStream(response, {
      onDiagnostic: async () => {
        throw new Error("diagnostic database unavailable");
      },
      onPageCheckpoint: async (page) => {
        checkpointedPageIds.push(page.id);
      },
    })).resolves.toEqual({ stage: "write", pages, failedPages: [] });

    expect(checkpointedPageIds).toEqual(pages.map((page) => page.id));
    expect(consoleError).toHaveBeenCalledOnce();
  });

  test("forwards page checkpoints before returning the write result", async () => {
    const page = {
      id: "overview",
      title: "Overview",
      route: "/",
      navigationPath: "default/overview.md",
      content: "# Overview\n",
      dependencies: emptyPageDependencyState(),
      contentHash: "a".repeat(64),
      pageInputHash: "b".repeat(64),
    };
    const onPageCheckpoint = vi.fn();
    const response = new Response([
      JSON.stringify({ kind: "page_checkpoint", page }),
      JSON.stringify({
        kind: "stage_result",
        result: { stage: "write", pages: [page] },
      }),
      "",
    ].join("\n"));

    await expect(readGenerationStageStream(response, {
      onPageCheckpoint,
    })).resolves.toEqual({ stage: "write", pages: [page], failedPages: [] });
    expect(onPageCheckpoint).toHaveBeenCalledWith(page);
  });

  test("rejects a stream that ends before a checkpoint result", async () => {
    const response = new Response(`${JSON.stringify({ kind: "heartbeat", elapsedMs: 1000 })}\n`);

    await expect(readGenerationStageStream(response)).rejects.toThrow(
      "Generation stage stream ended without a result.",
    );
  });

  test("preserves non-retryable stage failure classification", async () => {
    const response = new Response(`${JSON.stringify({
      kind: "error",
      error: {
        message: "Generated docs exhausted deterministic quality validation.",
        retryable: false,
        code: "docs_quality_validation_failed",
      },
    })}\n`);

    await expect(readGenerationStageStream(response)).rejects.toMatchObject({
      name: "GenerationStageRequestError",
      message: "Generated docs exhausted deterministic quality validation.",
      retryable: false,
      code: "docs_quality_validation_failed",
    });
  });

  test("treats legacy unclassified stage errors as retryable", async () => {
    const response = new Response(`${JSON.stringify({
      kind: "error",
      error: { message: "Temporary provider failure." },
    })}\n`);

    await expect(readGenerationStageStream(response)).rejects.toMatchObject({
      name: "GenerationStageRequestError",
      message: "Temporary provider failure.",
      retryable: true,
      code: "generation_stage_failed",
    });
  });
});
