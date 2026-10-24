import { z } from "zod";
import { gitObjectIdSchema } from "./source-control";

export const normalizedSourcePathSchema = z.string().refine(
  isNormalizedSourcePath,
  "Expected a normalized repository-relative path.",
);

export const pullRequestMergeCheckoutSchema = z.object({
  kind: z.literal("pull_request_merge"),
  pullRequestNumber: z.number().int().positive(),
  baselineRevision: gitObjectIdSchema,
  baseRevision: gitObjectIdSchema,
  headRevision: gitObjectIdSchema,
}).strict();

export const commitCheckoutSchema = z.object({
  kind: z.literal("commit"),
  baselineRevision: gitObjectIdSchema,
  targetRevision: gitObjectIdSchema,
}).strict();

export const sourceCheckoutSpecSchema = z.discriminatedUnion("kind", [
  pullRequestMergeCheckoutSchema,
  commitCheckoutSchema,
]);

export const sourceChangeStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
]);

export const sourceChangeSchema = z.object({
  path: normalizedSourcePathSchema,
  previousPath: normalizedSourcePathSchema.optional(),
  status: sourceChangeStatusSchema,
}).strict().superRefine((change, context) => {
  if (change.status === "renamed" && !change.previousPath) {
    context.addIssue({
      code: "custom",
      message: "Renamed source changes require a previous path.",
      path: ["previousPath"],
    });
  }
  if (change.status !== "renamed" && change.previousPath) {
    context.addIssue({
      code: "custom",
      message: "Only renamed source changes may include a previous path.",
      path: ["previousPath"],
    });
  }
});

export const repositorySnapshotSchema = z.object({
  targetRevision: gitObjectIdSchema,
  sourceTreeHash: gitObjectIdSchema,
  changes: z.array(sourceChangeSchema),
}).strict().superRefine((snapshot, context) => {
  if (!isStrictlyOrdered(snapshot.changes, compareSourceChanges)) {
    context.addIssue({
      code: "custom",
      message: "Repository source changes must be unique and deterministically ordered.",
      path: ["changes"],
    });
  }
  if (!hasUniquePaths(snapshot.changes)) {
    context.addIssue({
      code: "custom",
      message: "Repository source changes must have unique target paths.",
      path: ["changes"],
    });
  }
});

export type PullRequestMergeCheckout = z.infer<
  typeof pullRequestMergeCheckoutSchema
>;
export type CommitCheckout = z.infer<typeof commitCheckoutSchema>;
export type SourceCheckoutSpec = z.infer<typeof sourceCheckoutSpecSchema>;
export type SourceChangeStatus = z.infer<typeof sourceChangeStatusSchema>;
export type SourceChange = z.infer<typeof sourceChangeSchema>;
export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;

export function compareSourceChanges(
  left: SourceChange,
  right: SourceChange,
): number {
  return (
    compareStrings(left.path, right.path) ||
    compareStrings(left.previousPath ?? "", right.previousPath ?? "") ||
    compareStrings(left.status, right.status)
  );
}

function isNormalizedSourcePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }

  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isStrictlyOrdered<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1], values[index]) >= 0) {
      return false;
    }
  }
  return true;
}

function hasUniquePaths(changes: readonly SourceChange[]): boolean {
  return new Set(changes.map((change) => change.path)).size === changes.length;
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
