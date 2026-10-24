import { describe, expect, test, vi } from "vitest";
import {
  generationDiagnosticDraftKey,
  logGenerationUsageSummary,
  logPersistedGenerationUsageSummary,
  PROMPT_CACHE_COLD_MIN_REQUESTS,
  persistGenerationDiagnostic,
  persistGenerationUsage,
  summarizeGenerationUsageRecords,
} from "../src/generation-observability";
import type { Env } from "../src";
import type {
  GenerationRepairDiagnostic,
  GenerationUsageRecord,
} from "@doxahq/contracts";

const jobId = "11111111-1111-4111-8111-111111111111";
const diagnosticId = "22222222-2222-4222-8222-222222222222";

function usage(): GenerationUsageRecord {
  return {
    callId: "33333333-3333-4333-8333-333333333333",
    jobId,
    stageExecutionId: "44444444-4444-4444-8444-444444444444",
    stage: "analysis",
    operation: "analysis",
    modelRole: "planner",
    model: "x-ai/grok-4.5:nitro",
    pageId: null,
    pageTitle: null,
    pageRetry: null,
    attempt: 1,
    iteration: 1,
    providerGenerationId: null,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: "0.02",
    promptCostUsd: null,
    completionCostUsd: null,
    upstreamCostUsd: null,
    durationMs: null,
    finishReason: null,
    recordedAt: "2026-07-25T12:00:00.000Z",
  };
}

function diagnostic(draft = "broken <25 mdx"): GenerationRepairDiagnostic {
  return {
    diagnosticId,
    jobId,
    stageExecutionId: "44444444-4444-4444-8444-444444444444",
    pageId: "limits",
    pageTitle: "Limits",
    pageRetry: 0,
    writerAttempt: 1,
    attempt: 1,
    maxAttempts: 3,
    model: "moonshotai/kimi-k2.6:nitro",
    rule: "unexpected-character",
    message: "Unexpected character before name",
    line: 8,
    column: 9,
    snippet: "broken <25 mdx",
    draftSha256: "a".repeat(64),
    draft,
    draftTruncated: false,
    repairKind: "model_patch",
    repairSucceeded: true,
    rejectionReason: null,
    validationIssueCodes: [],
    createdAt: "2026-07-25T12:00:00.000Z",
  };
}

function environment() {
  const addJobEvent = vi.fn();
  const recordGenerationUsage = vi.fn(async () => undefined);
  const recordGenerationDiagnostic = vi.fn(async () => undefined);
  const put = vi.fn(async () => undefined);
  const getGenerationUsageSummary = vi.fn(async () => ({
    jobId,
    requestCount: 1,
    missingCostCount: 0,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: "0.02",
  }));
  return {
    env: {
      API: {
        addJobEvent,
        recordGenerationUsage,
        recordGenerationDiagnostic,
        getGenerationUsageSummary,
      },
      DOCS_BUCKET: { put },
    } as unknown as Env,
    addJobEvent,
    recordGenerationUsage,
    recordGenerationDiagnostic,
    getGenerationUsageSummary,
    put,
  };
}

describe("generation observability", () => {
  test("persists usage without creating a customer job event", async () => {
    const fixture = environment();
    await persistGenerationUsage(fixture.env, usage());

    expect(fixture.recordGenerationUsage).toHaveBeenCalledWith(usage());
    expect(fixture.addJobEvent).not.toHaveBeenCalled();
  });

  test("stores failed drafts under the contained private R2 prefix", async () => {
    const fixture = environment();
    await persistGenerationDiagnostic(fixture.env, diagnostic());

    expect(fixture.put).toHaveBeenCalledWith(
      `_generation-diagnostics/${jobId}/${diagnosticId}.mdx`,
      "broken <25 mdx",
      expect.objectContaining({
        customMetadata: { private: "true" },
      }),
    );
    expect(fixture.recordGenerationDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ draft: "broken <25 mdx" }),
      `_generation-diagnostics/${jobId}/${diagnosticId}.mdx`,
    );
    expect(fixture.addJobEvent).not.toHaveBeenCalled();
  });

  test("rejects uncontained diagnostic keys", () => {
    expect(() => generationDiagnosticDraftKey("../escape", diagnosticId))
      .toThrow("job ID is invalid");
  });

  test("logs persisted totals to the terminal without dashboard events", async () => {
    const fixture = environment();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await logPersistedGenerationUsageSummary(fixture.env, jobId, {
        stage: "analysis",
        status: "completed",
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(
        '"eventType":"generation_usage_stage_summary"',
      ));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"costUsd":"0.02"'));
      expect(fixture.addJobEvent).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test("sums stage costs with decimal precision", () => {
    expect(summarizeGenerationUsageRecords(jobId, [
      usage(),
      {
        ...usage(),
        callId: "55555555-5555-4555-8555-555555555555",
        costUsd: "0.000000000001",
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      },
    ])).toEqual({
      jobId,
      requestCount: 2,
      missingCostCount: 0,
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: "0.020000000001",
    });
  });

  test("warns when a busy stage read no cached prompt prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const summary = summarizeGenerationUsageRecords(
      jobId,
      Array.from({ length: PROMPT_CACHE_COLD_MIN_REQUESTS }, (_, index) => ({
        ...usage(),
        callId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
      })),
    );
    try {
      logGenerationUsageSummary(summary, { stage: "write", status: "completed" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        '"eventType":"generation_prompt_cache_cold"',
      ));

      warn.mockClear();
      logGenerationUsageSummary({ ...summary, cachedTokens: 1 }, { stage: "write" });
      logGenerationUsageSummary({ ...summary, requestCount: 1 }, { stage: "plan" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
