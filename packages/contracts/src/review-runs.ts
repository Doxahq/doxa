import { z } from "zod";

export const reviewRunStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
]);

export const reviewRunConclusionSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "action_required",
  /** Billing spec 10.6: a run that AI credits stopped never fails the customer's CI. */
  "neutral",
]);

export const doxabotReviewRunStateSchema = z.enum([
  "queued",
  "in_progress",
  "success",
  "failure",
  "cancelled",
  "action_required",
  "neutral",
]);

export const reviewRunMetricsSchema = z
  .object({
    changedSourceCount: z.number().int().nonnegative().optional(),
    regeneratedPageCount: z.number().int().nonnegative().optional(),
    reusedPageCount: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * A button on a completed check. The limits are GitHub's: at most three
 * actions, each with a label of 20, a description of 40 and an identifier
 * of 20 characters.
 */
export const reviewRunActionSchema = z
  .object({
    label: z.string().trim().min(1).max(20),
    description: z.string().trim().min(1).max(40),
    identifier: z.string().trim().min(1).max(20),
  })
  .strict();

const reviewRunCommandFields = {
  status: reviewRunStatusSchema,
  conclusion: reviewRunConclusionSchema.optional(),
  title: z.string().trim().min(1).max(255),
  summary: z.string().trim().min(1).max(60_000),
  detailsUrl: z.string().url().nullable().optional(),
  sourceRevision: z.string().trim().min(1).max(255),
  metrics: reviewRunMetricsSchema.optional(),
  /** Absent: the check keeps its buttons. Empty: the check shows none. */
  actions: z.array(reviewRunActionSchema).max(3).optional(),
};

export const createReviewRunInputSchema = z
  .object(reviewRunCommandFields)
  .strict()
  .superRefine(validateReviewRunState);

export const updateReviewRunInputSchema = z
  .object({
    externalRunId: z.string().trim().min(1).max(255),
    ...reviewRunCommandFields,
  })
  .strict()
  .superRefine(validateReviewRunState);

/**
 * The pull request check of a preview that the worker fails, when the run
 * needs a person rather than a retry (for example a merge conflict). Without
 * it, the check finishes as `failure` with a "Retry preview" button.
 */
export const failedJobCheckSchema = z
  .object({
    conclusion: z.enum(["failure", "action_required"]),
    title: z.string().trim().min(1).max(255),
    summary: z.string().trim().min(1).max(60_000),
  })
  .strict();

/** The status of a job that the watchdog ends because it waited or ran too long. */
export const timedOutJobStatusSchema = z.enum(["queued", "running"]);

export const reviewRunResultSchema = z
  .object({
    externalRunId: z.string().min(1),
    /** `skipped`: the update contradicted the job's end, so the check kept its state. */
    outcome: z.enum(["created", "updated", "skipped"]),
  })
  .strict();

export type ReviewRunStatus = z.infer<typeof reviewRunStatusSchema>;
export type ReviewRunConclusion = z.infer<typeof reviewRunConclusionSchema>;
export type DoxabotReviewRunState = z.infer<
  typeof doxabotReviewRunStateSchema
>;
export type ReviewRunMetrics = z.infer<typeof reviewRunMetricsSchema>;
export type ReviewRunAction = z.infer<typeof reviewRunActionSchema>;
export type FailedJobCheck = z.infer<typeof failedJobCheckSchema>;
export type TimedOutJobStatus = z.infer<typeof timedOutJobStatusSchema>;
export type CreateReviewRunInput = z.infer<
  typeof createReviewRunInputSchema
>;
export type UpdateReviewRunInput = z.infer<
  typeof updateReviewRunInputSchema
>;
export type ReviewRunResult = z.infer<typeof reviewRunResultSchema>;

function validateReviewRunState(
  value: {
    status: ReviewRunStatus;
    conclusion?: ReviewRunConclusion;
  },
  context: z.RefinementCtx,
): void {
  if (value.status === "completed" && value.conclusion === undefined) {
    context.addIssue({
      code: "custom",
      path: ["conclusion"],
      message: "A completed review run requires a conclusion.",
    });
  }

  if (value.status !== "completed" && value.conclusion !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["conclusion"],
      message: "Only a completed review run can have a conclusion.",
    });
  }
}
