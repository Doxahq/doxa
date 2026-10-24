import { z } from "zod";

/**
 * Where the REST reference of a run came from, and every spec problem that
 * the user can fix. The `analysis_complete` event carries it, and the
 * generation detail returns it. Fields added later are optional, so the
 * report of an older run still parses.
 */
export const referenceSourceStatusSchema = z.enum([
  /** The spec route built the REST surface. */
  "openapi",
  /** The spec route built it and skipped operations that failed gate G2. */
  "openapi_partial",
  /** The repository has no spec file; the model route ran. */
  "no_spec",
  /** Spec files exist, but none passed; the model route ran. */
  "spec_rejected",
  /** The spec-reader job did not run or did not answer; the model route ran. */
  "reader_unavailable",
]);

export const referenceSpecReportSchema = z.object({
  path: z.string(),
  /**
   * `refused`: gate G1 did not send the file. `unread`: the job did not
   * read it, because it was not available or did not answer.
   */
  outcome: z.enum(["parsed", "rejected", "refused", "unread"]),
  specVersion: z.string().optional(),
  code: z.string().optional(),
  /** The problem in plain words, from a fixed table. */
  message: z.string().optional(),
});

/** A spec file, a root or a referenced file, that did not parse. */
export const referenceFileIssueSchema = z.object({
  file: z.string(),
  reason: z.string(),
  message: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});

/** An operation that gate G2 skipped, so it has no page. */
export const referenceSkippedOperationSchema = z.object({
  specPath: z.string(),
  method: z.string(),
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

/** Skipped operations that a report lists; `skippedOperationCount` counts them all. */
export const MAX_REPORTED_SKIPPED_OPERATIONS = 50;

export const referenceSourceReportSchema = z.object({
  status: referenceSourceStatusSchema,
  specs: z.array(referenceSpecReportSchema),
  fileIssues: z.array(referenceFileIssueSchema).optional(),
  skippedOperations: z.array(referenceSkippedOperationSchema).max(MAX_REPORTED_SKIPPED_OPERATIONS).optional(),
  readerVersion: z.string().optional(),
  operationCount: z.number().int().nonnegative(),
  skippedOperationCount: z.number().int().nonnegative(),
  /** Known key shapes and credential examples that the sanitizer removed. */
  redactedSecretCount: z.number().int().nonnegative(),
});

export type ReferenceSourceStatus = z.infer<typeof referenceSourceStatusSchema>;
export type ReferenceSpecReport = z.infer<typeof referenceSpecReportSchema>;
export type ReferenceFileIssue = z.infer<typeof referenceFileIssueSchema>;
export type ReferenceSkippedOperation = z.infer<typeof referenceSkippedOperationSchema>;
export type ReferenceSourceReport = z.infer<typeof referenceSourceReportSchema>;
