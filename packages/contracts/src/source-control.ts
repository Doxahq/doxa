import { z } from "zod";

export const gitObjectIdSchema = z.string().regex(
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
  "Expected a lowercase hexadecimal Git object ID.",
);

export const sourceProviderSchema = z.enum(["github"]);
export const repositoryVisibilitySchema = z.enum(["private", "public"]);

export const sourceRevisionSchema = z.object({
  commitSha: gitObjectIdSchema,
}).strict();

export const sourceRepositorySchema = z.object({
  provider: sourceProviderSchema,
  externalId: z.string().min(1),
  installationExternalId: z.string().min(1),
  visibility: repositoryVisibilitySchema,
  defaultBranch: z.string().min(1),
}).strict();

export const sourceAuthorSchema = z.object({
  externalId: z.string().min(1),
  handle: z.string().min(1),
  avatarUrl: z.url().nullable(),
}).strict();

export const changeProposalActionSchema = z.enum([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "closed",
]);

export const normalizedChangeProposalEventSchema = z.object({
  kind: z.literal("change_proposal"),
  deliveryId: z.string().min(1),
  action: changeProposalActionSchema,
  repository: sourceRepositorySchema,
  change: z.object({
    externalId: z.string().min(1),
    number: z.number().int().positive(),
    // Optional for webhook deliveries normalized before author tracking existed.
    author: sourceAuthorSchema.nullable().optional(),
    draft: z.boolean(),
    merged: z.boolean(),
    baseRef: z.string().min(1),
    baseRevision: sourceRevisionSchema,
    headRevision: sourceRevisionSchema,
    sourceUpdatedAt: z.string().datetime(),
  }).strict(),
}).strict();

export const normalizedDefaultBranchPushEventSchema = z.object({
  kind: z.literal("default_branch_push"),
  deliveryId: z.string().min(1),
  repository: sourceRepositorySchema,
  ref: z.string().min(1),
  beforeRevision: sourceRevisionSchema,
  afterRevision: sourceRevisionSchema,
}).strict();

export const repositoryLifecycleActionSchema = z.enum([
  "connected",
  "updated",
  "disconnected",
]);

/**
 * The repository of a lifecycle event. GitHub sends a short repository
 * object in `installation` and `installation_repositories` events, with no
 * default branch.
 */
export const lifecycleRepositorySchema = sourceRepositorySchema.extend({
  defaultBranch: z.string().min(1).optional(),
}).strict();

export const normalizedRepositoryLifecycleEventSchema = z.object({
  kind: z.literal("repository_lifecycle"),
  deliveryId: z.string().min(1),
  action: repositoryLifecycleActionSchema,
  repository: lifecycleRepositorySchema,
}).strict();

export const normalizedSourceControlEventSchema = z.discriminatedUnion("kind", [
  normalizedChangeProposalEventSchema,
  normalizedDefaultBranchPushEventSchema,
  normalizedRepositoryLifecycleEventSchema,
]);

export const sourceControlIrrelevantReasonSchema = z.enum([
  "unsupported_event",
  "unsupported_action",
  "non_default_branch_push",
  "no_repository_changes",
]);

export const sourceControlEventParseResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("normalized"),
      events: z.array(normalizedSourceControlEventSchema).min(1),
    }).strict(),
    z.object({
      outcome: z.literal("irrelevant"),
      reason: sourceControlIrrelevantReasonSchema,
    }).strict(),
    z.object({
      outcome: z.literal("malformed"),
      reason: z.literal("invalid_payload"),
    }).strict(),
  ],
);

export type SourceProvider = z.infer<typeof sourceProviderSchema>;
export type RepositoryVisibility = z.infer<typeof repositoryVisibilitySchema>;
export type SourceRevision = z.infer<typeof sourceRevisionSchema>;
export type SourceRepository = z.infer<typeof sourceRepositorySchema>;
export type SourceAuthor = z.infer<typeof sourceAuthorSchema>;
export type ChangeProposalAction = z.infer<typeof changeProposalActionSchema>;
export type NormalizedChangeProposalEvent = z.infer<
  typeof normalizedChangeProposalEventSchema
>;
export type NormalizedDefaultBranchPushEvent = z.infer<
  typeof normalizedDefaultBranchPushEventSchema
>;
export type RepositoryLifecycleAction = z.infer<
  typeof repositoryLifecycleActionSchema
>;
export type NormalizedRepositoryLifecycleEvent = z.infer<
  typeof normalizedRepositoryLifecycleEventSchema
>;
export type NormalizedSourceControlEvent = z.infer<
  typeof normalizedSourceControlEventSchema
>;
export type SourceControlIrrelevantReason = z.infer<
  typeof sourceControlIrrelevantReasonSchema
>;
export type SourceControlEventParseResult = z.infer<
  typeof sourceControlEventParseResultSchema
>;
