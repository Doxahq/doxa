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
  /** The change now targets another branch. Other edits are not events. */
  "base_changed",
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
    /**
     * True when GitHub marks the author as a bot account (`user.type` is
     * `Bot`). Optional for deliveries normalized before this field existed.
     */
    authorIsBot: z.boolean().optional(),
    /**
     * True when the head branch is in another repository (a fork), or the
     * fork was deleted. Optional for deliveries normalized before this field
     * existed; those came only from the repository or from trusted forks.
     */
    fromFork: z.boolean().optional(),
    /**
     * The repository size in KB (`repository.size` of the webhook). Optional:
     * older deliveries did not keep it, and GitHub may leave it out.
     */
    repositorySizeKb: z.number().int().nonnegative().optional(),
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
  /** `owner/name`. Optional: older deliveries did not keep it. */
  fullName: z.string().min(1).optional(),
  /** The login of the account that owns the repository. */
  owner: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
}).strict();

/**
 * What happened to the repository on GitHub: `added` and `removed` come from
 * `installation_repositories`, the others are `repository` event actions.
 */
export const repositoryLifecycleChangeSchema = z.enum([
  "added",
  "removed",
  "created",
  "deleted",
  "edited",
  "renamed",
  "transferred",
  "privatized",
  "publicized",
  "archived",
  "unarchived",
]);

export const normalizedRepositoryLifecycleEventSchema = z.object({
  kind: z.literal("repository_lifecycle"),
  deliveryId: z.string().min(1),
  action: repositoryLifecycleActionSchema,
  /** Optional for deliveries normalized before this field existed. */
  change: repositoryLifecycleChangeSchema.optional(),
  repository: lifecycleRepositorySchema,
}).strict();

export const installationLifecycleActionSchema = z.enum([
  "created",
  "deleted",
  "suspended",
  "unsuspended",
  "permissions_accepted",
]);

/**
 * An `installation` event. It is about the whole installation: GitHub does
 * not always list its repositories.
 */
export const normalizedInstallationLifecycleEventSchema = z.object({
  kind: z.literal("installation_lifecycle"),
  deliveryId: z.string().min(1),
  provider: sourceProviderSchema,
  installationExternalId: z.string().min(1),
  action: installationLifecycleActionSchema,
  /**
   * The GitHub user who sent the event. Only `created` keeps it: that user
   * installed the app. Optional for older deliveries.
   */
  sender: z.object({
    externalId: z.string().min(1),
    login: z.string().min(1),
  }).strict().optional(),
}).strict();

export const normalizedSourceControlEventSchema = z.discriminatedUnion("kind", [
  normalizedChangeProposalEventSchema,
  normalizedDefaultBranchPushEventSchema,
  normalizedRepositoryLifecycleEventSchema,
  normalizedInstallationLifecycleEventSchema,
]);

export const sourceControlIrrelevantReasonSchema = z.enum([
  "unsupported_event",
  "unsupported_action",
  "non_default_branch_push",
  "no_repository_changes",
  /** Kept so stored deliveries stay readable. The parser no longer returns it. */
  "untrusted_fork",
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
export type RepositoryLifecycleChange = z.infer<
  typeof repositoryLifecycleChangeSchema
>;
export type InstallationLifecycleAction = z.infer<
  typeof installationLifecycleActionSchema
>;
export type NormalizedInstallationLifecycleEvent = z.infer<
  typeof normalizedInstallationLifecycleEventSchema
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
