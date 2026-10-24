import type { GenerationUsageRecord } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  evaluateGenerationObservabilitySchema,
  summarizeGenerationUsage,
  toGenerationDiagnosticMetadata,
} from "../../src/repositories/generation-observability";

const baseUsage: GenerationUsageRecord = {
  callId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  stageExecutionId: "33333333-3333-4333-8333-333333333333",
  stage: "write",
  operation: "page_write",
  modelRole: "writer",
  model: "moonshotai/kimi-k2.6:nitro",
  pageId: "overview",
  pageTitle: "Overview",
  pageRetry: 0,
  attempt: 1,
  iteration: 1,
  providerGenerationId: "gen-1",
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  cachedTokens: 40,
  cacheWriteTokens: null,
  reasoningTokens: 5,
  costUsd: "0.100000000000",
  promptCostUsd: null,
  completionCostUsd: null,
  upstreamCostUsd: null,
  durationMs: 100,
  finishReason: "stop",
  recordedAt: "2026-07-25T12:00:00.000Z",
};

describe("generation observability persistence helpers", () => {
  test("summarizes exact tokens and reports incomplete provider cost", () => {
    expect(summarizeGenerationUsage([
      baseUsage,
      {
        ...baseUsage,
        callId: "44444444-4444-4444-8444-444444444444",
        promptTokens: 50,
        completionTokens: 10,
        totalTokens: 60,
        cachedTokens: null,
        reasoningTokens: null,
        costUsd: null,
      },
    ])).toEqual({
      jobId: baseUsage.jobId,
      requestCount: 2,
      missingCostCount: 1,
      promptTokens: 150,
      completionTokens: 30,
      totalTokens: 180,
      cachedTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      costUsd: "0.100000000000",
    });
  });

  test("removes the failed draft from database diagnostic metadata", () => {
    const diagnostic = {
      diagnosticId: "55555555-5555-4555-8555-555555555555",
      jobId: baseUsage.jobId,
      stageExecutionId: baseUsage.stageExecutionId,
      pageId: "overview",
      pageTitle: "Overview",
      pageRetry: 0,
      writerAttempt: 1,
      attempt: 1,
      maxAttempts: 3,
      model: baseUsage.model,
      rule: "unexpected-character",
      message: "Unexpected character `<`",
      line: 4,
      column: 8,
      snippet: "value < limit",
      draftSha256: "a".repeat(64),
      draft: "# Overview\n\nvalue < limit\n",
      draftTruncated: false,
      repairKind: "model_patch" as const,
      repairSucceeded: false,
      rejectionReason: "patch-does-not-overlap-parser-location",
      validationIssueCodes: [],
      createdAt: "2026-07-25T12:00:00.000Z",
    };

    expect(toGenerationDiagnosticMetadata(
      diagnostic,
      "_generation-diagnostics/job/diagnostic.mdx",
    )).not.toHaveProperty("draft");
  });

  test("reports columns missing from an older diagnostics schema", () => {
    expect(evaluateGenerationObservabilitySchema([
      "diagnostic_id",
      "job_id",
      "page_id",
      "page_retry",
      "attempt",
      "repair_succeeded",
    ])).toEqual({
      ready: false,
      missingColumns: [
        "max_attempts",
        "rejection_reason",
        "validation_issue_codes",
        "writer_attempt",
      ],
    });
  });

  test("accepts the complete generation observability schema", () => {
    expect(evaluateGenerationObservabilitySchema([
      "writer_attempt",
      "max_attempts",
      "rejection_reason",
      "validation_issue_codes",
    ])).toEqual({
      ready: true,
      missingColumns: [],
    });
  });
});
