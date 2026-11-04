import { z } from "zod";

export const GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS = 256 * 1024;
export const GENERATION_DIAGNOSTIC_DRAFT_MAX_BYTES = 256 * 1024;

export function truncateGenerationDiagnosticDraft(value: string): {
  draft: string;
  truncated: boolean;
} {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= GENERATION_DIAGNOSTIC_DRAFT_MAX_BYTES) {
    return { draft: value, truncated: false };
  }
  let bytes = 0;
  const chunks: string[] = [];
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > GENERATION_DIAGNOSTIC_DRAFT_MAX_BYTES) break;
    chunks.push(character);
    bytes += characterBytes;
  }
  return { draft: chunks.join(""), truncated: true };
}

/**
 * Provider-neutral classes of a failed model call. The agent decides retries
 * from them; the worker reads them from error messages, which keep the class
 * as "Model provider error (<class>)" across Workflow steps.
 */
export const MODEL_CALL_ERROR_CLASSES = [
  "rate_limited",
  "overloaded",
  "server_error",
  "timeout",
  "spend_cap",
  "auth",
  "model_not_found",
  "too_large",
  "invalid_request",
  "unknown",
] as const;

export type ModelCallErrorClass = (typeof MODEL_CALL_ERROR_CLASSES)[number];

/** Classes that fail every call of a run the same way, so the run stops. */
export const RUN_STOPPING_MODEL_ERROR_CLASSES = [
  "spend_cap",
  "auth",
  "model_not_found",
] as const satisfies readonly ModelCallErrorClass[];

export function modelProviderErrorMessage(errorClass: ModelCallErrorClass, detail: string): string {
  return `Model provider error (${errorClass}): ${detail}`;
}

/** True when a message, also a serialized one, names a run-stopping class. */
export function isRunStoppingModelErrorMessage(message: string): boolean {
  return RUN_STOPPING_MODEL_ERROR_CLASSES.some((errorClass) =>
    message.includes(`Model provider error (${errorClass})`)
  );
}

export const generationModelConfigSchema = z.object({
  plannerModel: z.string().trim().min(1),
  writerModel: z.string().trim().min(1),
  /** Writes the last retry of a failing page. Same provider as the writer. */
  writerFallbackModel: z.string().trim().min(1).optional(),
  /**
   * @deprecated File-by-file REST extraction was removed, and the container
   * ignores this field. It stays for one release, so an older worker can
   * still call a newer container.
   */
  restExtractionModel: z.string().trim().min(1).optional(),
}).strict();

export const generationStageNameSchema = z.enum([
  "analysis",
  "plan",
  "structure",
  "write",
]);

export const generationOperationSchema = z.enum([
  "analysis",
  "structure",
  "structure_review",
  "page_write",
  "mdx_repair",
  /** No run makes these calls now; usage records of older runs (file-by-file REST extraction) have them. */
  "rest_extraction",
]);

export const generationModelRoleSchema = z.enum(["planner", "writer"]);

const nullableTokenCountSchema = z.number().int().nonnegative().nullable();
const nullableUsdSchema = z.string()
  .regex(/^\d+(?:\.\d{1,12})?$/, "Expected a non-negative decimal USD amount.")
  .nullable();

export const generationUsageRecordSchema = z.object({
  callId: z.string().uuid(),
  jobId: z.string().uuid(),
  stageExecutionId: z.string().uuid(),
  stage: generationStageNameSchema,
  operation: generationOperationSchema,
  modelRole: generationModelRoleSchema,
  model: z.string().trim().min(1),
  pageId: z.string().trim().min(1).nullable(),
  pageTitle: z.string().trim().min(1).nullable(),
  pageRetry: z.number().int().nonnegative().nullable(),
  attempt: z.number().int().positive().nullable(),
  iteration: z.number().int().positive(),
  providerGenerationId: z.string().trim().min(1).nullable(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: nullableTokenCountSchema,
  cacheWriteTokens: nullableTokenCountSchema,
  reasoningTokens: nullableTokenCountSchema,
  costUsd: nullableUsdSchema,
  promptCostUsd: nullableUsdSchema,
  completionCostUsd: nullableUsdSchema,
  upstreamCostUsd: nullableUsdSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  finishReason: z.string().trim().min(1).nullable(),
  recordedAt: z.string().datetime(),
}).strict().superRefine((record, context) => {
  if (record.totalTokens < record.promptTokens + record.completionTokens) {
    context.addIssue({
      code: "custom",
      path: ["totalTokens"],
      message: "Total tokens cannot be smaller than prompt plus completion tokens.",
    });
  }
  const hasPage = record.pageId !== null || record.pageTitle !== null;
  if (hasPage && (record.pageId === null || record.pageTitle === null)) {
    context.addIssue({
      code: "custom",
      path: ["pageId"],
      message: "Page ID and title must either both be present or both be null.",
    });
  }
});

export const generationRepairKindSchema = z.literal("model_patch");

export const generationRepairDiagnosticSchema = z.object({
  diagnosticId: z.string().uuid(),
  jobId: z.string().uuid(),
  stageExecutionId: z.string().uuid(),
  pageId: z.string().trim().min(1),
  pageTitle: z.string().trim().min(1),
  pageRetry: z.number().int().nonnegative(),
  writerAttempt: z.number().int().positive(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  model: z.string().trim().min(1),
  rule: z.string().trim().min(1),
  message: z.string().trim().min(1),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  snippet: z.string().max(2_000).nullable(),
  draftSha256: z.string().regex(/^[0-9a-f]{64}$/),
  draft: z.string().max(GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS),
  draftTruncated: z.boolean(),
  repairKind: generationRepairKindSchema,
  repairSucceeded: z.boolean(),
  rejectionReason: z.string().max(2_000).nullable(),
  validationIssueCodes: z.array(z.string().trim().min(1)).max(20),
  createdAt: z.string().datetime(),
}).strict().superRefine((diagnostic, context) => {
  if (diagnostic.attempt > diagnostic.maxAttempts) {
    context.addIssue({
      code: "custom",
      path: ["attempt"],
      message: "Repair attempt cannot exceed the configured maximum.",
    });
  }
});

export const generationUsageSummarySchema = z.object({
  jobId: z.string().uuid(),
  requestCount: z.number().int().nonnegative(),
  missingCostCount: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable(),
}).strict();

/**
 * Spend for one project, across every generation it ever ran. It counts
 * deleted generations, because `generation_usage_records` keeps its project
 * attribution after the generation row is gone.
 */
export const generationProjectUsageTotalsSchema = z.object({
  projectId: z.string().uuid(),
  requestCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.string().nullable(),
}).strict();

export interface GenerationDatabaseCompatibility {
  ready: boolean;
  missingColumns: string[];
}

export type GenerationModelConfig = z.infer<typeof generationModelConfigSchema>;
export type GenerationStageName = z.infer<typeof generationStageNameSchema>;
export type GenerationOperation = z.infer<typeof generationOperationSchema>;
export type GenerationModelRole = z.infer<typeof generationModelRoleSchema>;
export type GenerationUsageRecord = z.infer<typeof generationUsageRecordSchema>;
export type GenerationRepairDiagnostic = z.infer<
  typeof generationRepairDiagnosticSchema
>;
export type GenerationUsageSummary = z.infer<typeof generationUsageSummarySchema>;
export type GenerationProjectUsageTotals = z.infer<
  typeof generationProjectUsageTotalsSchema
>;
