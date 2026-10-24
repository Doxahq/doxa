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
]);

export const doxabotReviewRunStateSchema = z.enum([
  "queued",
  "in_progress",
  "success",
  "failure",
  "cancelled",
  "action_required",
]);

export const reviewRunMetricsSchema = z
  .object({
    changedSourceCount: z.number().int().nonnegative().optional(),
    regeneratedPageCount: z.number().int().nonnegative().optional(),
    reusedPageCount: z.number().int().nonnegative().optional(),
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

export const reviewRunResultSchema = z
  .object({
    externalRunId: z.string().min(1),
    outcome: z.enum(["created", "updated"]),
  })
  .strict();

export type ReviewRunStatus = z.infer<typeof reviewRunStatusSchema>;
export type ReviewRunConclusion = z.infer<typeof reviewRunConclusionSchema>;
export type DoxabotReviewRunState = z.infer<
  typeof doxabotReviewRunStateSchema
>;
export type ReviewRunMetrics = z.infer<typeof reviewRunMetricsSchema>;
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
