import {
  GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS,
  truncateGenerationDiagnosticDraft,
  type GenerationRepairDiagnostic,
  type GenerationUsageRecord,
  type GenerationUsageSummary,
} from "@doxahq/contracts";
import { GENERATION_DIAGNOSTIC_PREFIX } from "@doxahq/contracts/storage-lifecycle";
import type { Env } from "./index";

export async function persistGenerationUsage(
  env: Env,
  record: GenerationUsageRecord,
): Promise<void> {
  await env.API.recordGenerationUsage(record);
}

export async function persistGenerationDiagnostic(
  env: Env,
  diagnostic: GenerationRepairDiagnostic,
): Promise<void> {
  const draftKey = generationDiagnosticDraftKey(
    diagnostic.jobId,
    diagnostic.diagnosticId,
  );
  const bounded = truncateGenerationDiagnosticDraft(
    diagnostic.draft.slice(
      0,
      GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS,
    ),
  );
  const draft = bounded.draft;
  await env.DOCS_BUCKET.put(draftKey, draft, {
    httpMetadata: { contentType: "text/mdx; charset=utf-8" },
    // The R2 lifecycle rule of the prefix expires the draft.
    customMetadata: { private: "true" },
  });
  await env.API.recordGenerationDiagnostic(
    {
      ...diagnostic,
      draft,
      draftTruncated:
        diagnostic.draftTruncated ||
        bounded.truncated ||
        diagnostic.draft.length > draft.length,
    },
    draftKey,
  );
}

export function generationDiagnosticDraftKey(
  jobId: string,
  diagnosticId: string,
): string {
  assertUuid(jobId, "job ID");
  assertUuid(diagnosticId, "diagnostic ID");
  return `${GENERATION_DIAGNOSTIC_PREFIX}${jobId}/${diagnosticId}.mdx`;
}

/**
 * Below this many model calls a stage can end without any repeated prefix,
 * for example a plan that needed one analysis call.
 */
export const PROMPT_CACHE_COLD_MIN_REQUESTS = 10;

export function logGenerationUsageSummary(
  summary: GenerationUsageSummary,
  scope: { stage?: string; status?: string } = {},
): void {
  console.log(JSON.stringify({
    service: "doxa-agent-worker",
    eventType: scope.stage
      ? "generation_usage_stage_summary"
      : "generation_usage_summary",
    ...scope,
    ...summary,
  }));
  if (isPromptCacheCold(summary)) {
    console.warn(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "generation_prompt_cache_cold",
      ...scope,
      jobId: summary.jobId,
      requestCount: summary.requestCount,
      promptTokens: summary.promptTokens,
      message: "No model call read a cached prompt prefix. Check the cache markers and the provider.",
    }));
  }
}

/** A stage with many calls and no cache read means caching is not working. */
export function isPromptCacheCold(summary: GenerationUsageSummary): boolean {
  return summary.requestCount >= PROMPT_CACHE_COLD_MIN_REQUESTS &&
    summary.cachedTokens === 0;
}

export function summarizeGenerationUsageRecords(
  jobId: string,
  records: readonly GenerationUsageRecord[],
): GenerationUsageSummary {
  let cost = 0n;
  let hasCost = false;
  let missingCostCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  for (const record of records) {
    if (record.jobId !== jobId) {
      throw new Error("Generation usage summary cannot span multiple jobs.");
    }
    promptTokens += record.promptTokens;
    completionTokens += record.completionTokens;
    totalTokens += record.totalTokens;
    cachedTokens += record.cachedTokens ?? 0;
    cacheWriteTokens += record.cacheWriteTokens ?? 0;
    reasoningTokens += record.reasoningTokens ?? 0;
    if (record.costUsd === null) {
      missingCostCount++;
    } else {
      hasCost = true;
      cost += parseUsd(record.costUsd);
    }
  }
  return {
    jobId,
    requestCount: records.length,
    missingCostCount,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheWriteTokens,
    reasoningTokens,
    costUsd: hasCost ? formatUsd(cost) : null,
  };
}

export async function logPersistedGenerationUsageSummary(
  env: Env,
  jobId: string,
  scope: { stage?: string; status?: string } = {},
): Promise<void> {
  const summary = await env.API.getGenerationUsageSummary(jobId);
  if (summary) logGenerationUsageSummary(summary, scope);
}

export async function deleteExpiredGenerationObservability(
  env: Env,
  now = new Date(),
): Promise<void> {
  const deleted = await env.API.deleteExpiredGenerationObservability(
    now.toISOString(),
    500,
  );
  if (deleted.diagnostics > 0) {
    console.log(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "generation_observability_retention_cleanup",
      diagnostics: deleted.diagnostics,
    }));
  }
}

function assertUuid(value: string, label: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error(`Generation diagnostic ${label} is invalid.`);
  }
}

function parseUsd(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000_000n +
    BigInt(fraction.padEnd(12, "0"));
}

function formatUsd(value: bigint): string {
  const whole = value / 1_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000n)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
