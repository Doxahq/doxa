import {
  containerGenerationStageStreamRecordSchema,
  generationModelConfigSchema,
  generationRepairDiagnosticSchema,
  generationUsageRecordSchema,
  writerHandoffManifestSchema,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

const jobId = "11111111-1111-4111-8111-111111111111";
const stageExecutionId = "22222222-2222-4222-8222-222222222222";
const callId = "33333333-3333-4333-8333-333333333333";
const diagnosticId = "44444444-4444-4444-8444-444444444444";

describe("generation observability contracts", () => {
  test("accepts an explicit planner and writer model pair", () => {
    expect(generationModelConfigSchema.parse({
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
    })).toEqual({
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
    });
  });

  test("rejects invalid usage counts and accepts detailed provider usage", () => {
    const record = {
      callId,
      jobId,
      stageExecutionId,
      stage: "write" as const,
      operation: "page_write" as const,
      modelRole: "writer" as const,
      model: "moonshotai/kimi-k2.6:nitro",
      pageId: "audit-logs",
      pageTitle: "Audit Logs",
      pageRetry: 1,
      attempt: 2,
      iteration: 3,
      providerGenerationId: "gen-1",
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
      costUsd: "0.001234000000",
      promptCostUsd: "0.000900000000",
      completionCostUsd: "0.000334000000",
      upstreamCostUsd: "0.001000000000",
      durationMs: 250,
      finishReason: "stop",
      recordedAt: "2026-07-25T12:00:00.000Z",
    };

    expect(generationUsageRecordSchema.parse(record)).toEqual(record);
    expect(generationUsageRecordSchema.safeParse({
      ...record,
      promptTokens: -1,
    }).success).toBe(false);
  });

  test("accepts exact parser diagnostics and bounds failed drafts", () => {
    const diagnostic = {
      diagnosticId,
      jobId,
      stageExecutionId,
      pageId: "audit-logs",
      pageTitle: "Audit Logs",
      pageRetry: 0,
      writerAttempt: 1,
      attempt: 2,
      maxAttempts: 3,
      model: "moonshotai/kimi-k2.6:nitro",
      rule: "unexpected-character",
      message: "Unexpected character `<`",
      line: 12,
      column: 18,
      snippet: "Use value < limit.",
      draftSha256: "a".repeat(64),
      draft: "# Audit Logs\n\nUse value < limit.\n",
      draftTruncated: false,
      repairKind: "model_patch" as const,
      repairSucceeded: false,
      rejectionReason: "patch-does-not-overlap-parser-location",
      validationIssueCodes: [],
      createdAt: "2026-07-25T12:00:00.000Z",
    };

    expect(generationRepairDiagnosticSchema.parse(diagnostic)).toEqual(
      diagnostic,
    );
    expect(generationRepairDiagnosticSchema.safeParse({
      ...diagnostic,
      draft: "x".repeat(256 * 1024 + 1),
    }).success).toBe(false);
    expect(generationRepairDiagnosticSchema.safeParse({
      ...diagnostic,
      attempt: 4,
    }).success).toBe(false);
    expect(generationRepairDiagnosticSchema.safeParse({
      ...diagnostic,
      repairKind: "deterministic",
    }).success).toBe(false);
  });

  test("streams usage and diagnostics outside customer generation events", () => {
    expect(containerGenerationStageStreamRecordSchema.safeParse({
      kind: "usage",
      record: {
        callId,
        jobId,
        stageExecutionId,
        stage: "analysis",
        operation: "analysis",
        modelRole: "planner",
        model: "x-ai/grok-4.5:nitro",
        pageId: null,
        pageTitle: null,
        pageRetry: null,
        attempt: null,
        iteration: 1,
        providerGenerationId: null,
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: null,
        promptCostUsd: null,
        completionCostUsd: null,
        upstreamCostUsd: null,
        durationMs: null,
        finishReason: null,
        recordedAt: "2026-07-25T12:00:00.000Z",
      },
    }).success).toBe(true);
  });
});

describe("writer handoff contract", () => {
  const handoff = {
    schemaVersion: 1 as const,
    sourceRevision: "a".repeat(40),
    project: {
      name: "FlagForge",
      slug: "flagforge",
      audience: "Developers integrating FlagForge",
      documentationGoal: "Explain supported public behavior.",
    },
    shared: {
      terminology: ["flag", "environment"],
      factualConstraints: ["Use repository evidence only."],
      editorialConstraints: ["Write for product users."],
      validationConstraints: ["Return valid MDX."],
    },
    pages: [
      {
        pageId: "overview",
        title: "Overview",
        route: "/overview",
        pageType: "concept",
        purpose: "Introduce the product.",
        requiredTopics: ["Core workflow"],
        sourceEvidence: [{
          path: "src/index.ts",
          symbols: ["createClient"],
          reason: "Public entry point",
        }],
        relatedPageIds: [],
        exclusions: ["Internal deployment details"],
      },
    ],
  };

  test("accepts a deterministic page-writing contract", () => {
    expect(writerHandoffManifestSchema.parse(handoff)).toEqual(handoff);
  });

  test("rejects duplicate page IDs", () => {
    expect(writerHandoffManifestSchema.safeParse({
      ...handoff,
      pages: [...handoff.pages, handoff.pages[0]],
    }).success).toBe(false);
  });
});
