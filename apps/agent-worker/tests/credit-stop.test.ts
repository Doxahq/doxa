import { describe, expect, test, vi } from "vitest";
import {
  GenerationCreditsStoppedError,
  creditStopReasonOf,
} from "../src/generation-errors";
import { isRunStoppingError } from "../src/generation-page-failures";
import { GenerationWorkflowRunner } from "../src/generation-workflow-runtime";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function usageSummary() {
  return {
    jobId: JOB_ID,
    requestCount: 0,
    missingCostCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
  };
}

/** A revision-aware production run (a manual run at a fixed commit). */
function productionExecutionContext() {
  return {
    project: { id: "22222222-2222-4222-8222-222222222222", name: "Doxa", slug: "doxa", siteId: "44444444-4444-4444-8444-444444444444", siteSlug: "doxa" },
    repository: { id: "55555555-5555-4555-8555-555555555555", fullName: "acme/docs", defaultBranch: "main", installationId: "123", isPrivate: true },
    sourceRepository: { externalId: "987", owner: "acme", name: "docs" },
    job: {
      id: JOB_ID,
      trigger: "manual",
      publicationMode: "production",
      sourceProvider: null,
      sourceInstallationExternalId: null,
      changeExternalId: null,
      baselineRevision: null,
      targetRevision: "c".repeat(40),
      sourceTreeHash: null,
      baselineVersionId: null,
      agentModel: "claude-sonnet-5-5",
      plannerModel: "claude-sonnet-5-5",
      writerModel: "claude-haiku-5-5",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      generationProfile: "fast-mvp",
      generatorFingerprint: "doxa-v1",
      externalReviewRunId: null,
    },
    changeProposal: null,
    baselineVersion: null,
    currentPreviewVersionId: null,
  };
}

/** A full production run whose credit meter stopped it before the first model call. */
function runnerWith(
  stopReason: "credits_exhausted" | "credit_cap" | null,
  executionContext: ReturnType<typeof productionExecutionContext> | null = null,
) {
  const api = {
    getGenerationDatabaseCompatibility: vi.fn(async () => ({ ready: true, missingColumns: [] })),
    getGenerationExecutionContext: vi.fn(async () => executionContext),
    getGenerationResumedAt: vi.fn(async () => null),
    getGenerationControl: vi.fn(async () => ({ status: "enabled" as const, reason: null })),
    createModelAccessToken: vi.fn(async () => ({ token: "token", expiresAt: new Date(Date.now() + 60_000).toISOString() })),
    markJobRunning: vi.fn(async () => undefined),
    getGenerationContext: vi.fn(async () => ({ repository: { fullName: "acme/docs" }, project: {} })),
    addJobEvent: vi.fn(async () => ({})),
    isJobActive: vi.fn(async () => false),
    getJobStopReason: vi.fn(async () => stopReason),
    markJobStopped: vi.fn(async () => undefined),
    markJobFailed: vi.fn(async () => undefined),
    markJobCancelled: vi.fn(async () => undefined),
    getGenerationUsageSummary: vi.fn(async () => usageSummary()),
  };
  const bucket = {
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    delete: vi.fn(async () => undefined),
  };
  const runner = new GenerationWorkflowRunner({ API: api, DOCS_BUCKET: bucket, ANTHROPIC_API_KEY: "key" } as never);
  const run = runner.run(
    { payload: { jobId: JOB_ID, projectId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333" }, timestamp: new Date() },
    { do: async <T>(_name: string, _config: unknown, callback: () => Promise<T>) => callback() },
  );
  return { api, bucket, run };
}

describe("a run that the credit meter stopped (billing spec 10.5, 10.6)", () => {
  test("ends as stopped_credits, not cancelled or failed, and keeps its page checkpoints", async () => {
    const { api, bucket, run } = runnerWith("credits_exhausted");
    await expect(run).rejects.toThrow(/generation stopped for credits \(credits_exhausted\)/i);
    expect(api.markJobStopped).toHaveBeenCalledWith(JOB_ID, {
      reason: "credits_exhausted",
      message: expect.stringContaining("AI credits ran out"),
    });
    expect(api.markJobFailed).not.toHaveBeenCalled();
    expect(api.markJobCancelled).not.toHaveBeenCalled();
    // No checkpoint deletion: the prefix is never listed for deletion.
    expect(bucket.list).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  test("records the step where the meter stopped it, so a person can continue the run", async () => {
    const { api, run } = runnerWith("credit_cap", productionExecutionContext());
    await expect(run).rejects.toThrow(/generation stopped for credits \(credit_cap\)/i);
    const stepEvents = api.addJobEvent.mock.calls
      .map((call) => (call as unknown[])[1] as { type: string; data?: Record<string, unknown> })
      .filter((event) => event.type === "credits_stopped_step");
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]?.data).toEqual({
      stepName: expect.any(String),
      count: expect.any(Number),
      resumable: true,
    });
    // Not a failure: no failed-step event, so the log shows only the credit stop.
    expect(api.addJobEvent.mock.calls.some((call) => ((call as unknown[])[1] as { type: string }).type === "workflow_step_failed")).toBe(false);
  });

  test("a run that ended for another reason keeps the old path", async () => {
    const { api, bucket, run } = runnerWith(null);
    await expect(run).rejects.toThrow("Generation job is no longer active.");
    expect(api.markJobStopped).not.toHaveBeenCalled();
    expect(api.markJobFailed).not.toHaveBeenCalled();
    expect(bucket.list).toHaveBeenCalled();
  });

  test("the stop error stops the batch dispatch and keeps its reason through a step", () => {
    const error = new GenerationCreditsStoppedError("credit_cap");
    expect(isRunStoppingError(error)).toBe(true);
    expect(creditStopReasonOf(error)).toBe("credit_cap");
    // A Workflow step keeps only the message.
    expect(creditStopReasonOf(new Error(error.message))).toBe("credit_cap");
    expect(creditStopReasonOf(new Error("Generation job is no longer active."))).toBeNull();
  });
});
