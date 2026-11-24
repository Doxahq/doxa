import { z } from "zod";
import { gitBranchNameSchema } from "./repository-branches";
import { repositoryVisibilitySchema } from "./source-control";

export const doxabotUnavailableReasonSchema = z.enum([
  "global_disabled",
  "initial_generation_required",
  "public_repository_disabled",
  "repository_not_connected",
]);

const availableDoxabotEligibilitySchema = z.object({
  available: z.literal(true),
  enabled: z.boolean(),
  reason: z.null(),
}).strict();

const unavailableDoxabotEligibilitySchema = z.object({
  available: z.literal(false),
  enabled: z.literal(false),
  reason: doxabotUnavailableReasonSchema,
}).strict();

export const doxabotEligibilitySchema = z.discriminatedUnion("available", [
  availableDoxabotEligibilitySchema,
  unavailableDoxabotEligibilitySchema,
]);

/**
 * What a merge into the production branch starts: `manual` lists the merged
 * pull requests, `batched` runs once merges stop for the quiet time, and
 * `every_merge` runs after each merge. Every run goes to a review.
 */
export const doxabotMergeTriggerSchema = z.enum([
  "manual",
  "batched",
  "every_merge",
]);

/** The quiet times that a batched trigger waits after the last merge. */
export const DOXABOT_BATCH_QUIET_MINUTES = [15, 30, 60, 360] as const;

export const doxabotBatchQuietMinutesSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
  z.literal(360),
]);

/** The most bot logins that one project may allow. */
export const DOXABOT_ALLOWED_BOT_LOGINS_LIMIT = 20;

/**
 * A GitHub login of a bot account, such as `dependabot[bot]`. The `[bot]`
 * suffix is optional: `dependabot` allows the same bot.
 */
export const doxabotBotLoginSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/, "Enter a GitHub login, such as dependabot[bot].");

/** The login without case and without the `[bot]` suffix, so both spellings match. */
export function normalizeBotLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}

export const doxabotAllowedBotLoginsSchema = z
  .array(doxabotBotLoginSchema)
  .max(DOXABOT_ALLOWED_BOT_LOGINS_LIMIT);

/**
 * Why Doxabot stopped updating the site on its own. The site stays live; the
 * owner decides what to do next (Decision 4).
 * - `repository_privatized`: the repository became private. Doxabot turned
 *   pull request previews off and set merges to manual. A settings change
 *   clears it.
 * - `repository_removed`: the repository was removed from the GitHub App.
 * - `repository_deleted`: the repository was deleted on GitHub.
 * - `installation_suspended` / `installation_deleted`: the GitHub App was
 *   suspended or uninstalled.
 */
export const doxabotAutomationWarningSchema = z.enum([
  "repository_privatized",
  "repository_removed",
  "repository_deleted",
  "installation_suspended",
  "installation_deleted",
]);

const doxabotSettingsBaseSchema = z.object({
  enabled: z.boolean(),
  mergeTrigger: doxabotMergeTriggerSchema,
  batchQuietMinutes: doxabotBatchQuietMinutesSchema,
  repositoryVisibility: repositoryVisibilitySchema.nullable(),
  /**
   * The branch that production generations read, that merges go into, and
   * that pull requests must target for a preview. Null without a repository.
   */
  productionBranch: z.string().min(1).nullable(),
  /** The repository's default branch on GitHub. Null without a repository. */
  repositoryDefaultBranch: z.string().min(1).nullable(),
  /**
   * Bot accounts whose pull requests get previews. Doxabot skips every other
   * bot. Optional, so an older API stays readable; absent means none.
   */
  allowedBotLogins: doxabotAllowedBotLoginsSchema.optional(),
  /** Why automation stopped, or null. Optional, so an older API stays readable. */
  automationWarning: doxabotAutomationWarningSchema.nullable().optional(),
  updatedAt: z.string().datetime().nullable(),
});

export const doxabotSettingsSchema = z.discriminatedUnion("available", [
  doxabotSettingsBaseSchema.extend({
    available: z.literal(true),
    unavailableReason: z.null(),
  }).strict(),
  doxabotSettingsBaseSchema.extend({
    available: z.literal(false),
    unavailableReason: doxabotUnavailableReasonSchema,
  }).strict(),
]);

/**
 * A partial update: the client sends only the fields it changes, so a later
 * setting does not break a client that does not know it.
 */
export const updateDoxabotSettingsInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    mergeTrigger: doxabotMergeTriggerSchema.optional(),
    batchQuietMinutes: doxabotBatchQuietMinutesSchema.optional(),
    /** Replaces the whole list. */
    allowedBotLogins: doxabotAllowedBotLoginsSchema.optional(),
    /** The API checks on GitHub that the branch exists before it saves it. */
    productionBranch: gitBranchNameSchema.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "The update changes no setting.",
  });

/** Pull requests merged since the last production generation started. */
export const pendingMergesSchema = z
  .object({
    merges: z.array(
      z
        .object({
          number: z.number().int().positive(),
          mergedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export type DoxabotUnavailableReason = z.infer<
  typeof doxabotUnavailableReasonSchema
>;
export type DoxabotEligibility = z.infer<typeof doxabotEligibilitySchema>;
export type DoxabotSettingsDto = z.infer<typeof doxabotSettingsSchema>;
export type UpdateDoxabotSettingsInput = z.infer<
  typeof updateDoxabotSettingsInputSchema
>;
export type DoxabotMergeTrigger = z.infer<typeof doxabotMergeTriggerSchema>;
export type DoxabotAutomationWarning = z.infer<typeof doxabotAutomationWarningSchema>;
export type DoxabotBatchQuietMinutes = z.infer<
  typeof doxabotBatchQuietMinutesSchema
>;
export type PendingMerges = z.infer<typeof pendingMergesSchema>;

/** The metered AI action that the next pull request or merge run is charged as (billing decision D21). */
export const nextPullRequestRunActionSchema = z.enum(["generation.run", "doxabot.run"]);
export type NextPullRequestRunAction = z.infer<typeof nextPullRequestRunActionSchema>;

/**
 * `GET /projects/:projectId/generation-cache` and
 * `POST /projects/:projectId/generation-cache/clear`, as `{ generationCache }`.
 */
export const projectGenerationCacheSchema = z.object({
  siteId: z.string().min(1),
  /** The last Clear cache, or null. Baselines from before it are ignored. */
  clearedAt: z.string().nullable(),
  /**
   * Decision D21: true when the next pull request run has no baseline, so
   * it analyzes the whole repository and is charged as a Full generation
   * (`generation.run`). It follows the rule of pull request admission: the
   * published version is the baseline unless Clear cache retired it, so the
   * project is cold before the first publish and after Clear cache. A pull
   * request that already has a successful preview runs warm from that
   * preview, whatever this says.
   */
  nextPullRequestRunCold: z.boolean(),
  /**
   * The action of that run: `generation.run` when cold (Full generation),
   * else `doxabot.run` (Update run). Read its estimate from
   * `GET /projects/:projectId/credit-estimate?action=<this>`.
   */
  nextPullRequestRunAction: nextPullRequestRunActionSchema,
  /**
   * True when the next generation that a person starts analyzes the whole
   * repository: no published production version with its saved run state
   * (before the first generation, after Clear cache, or when only written or
   * starter pages are published). Such a run is always a Full generation;
   * this only says whether it starts cold.
   */
  nextGenerationRunCold: z.boolean(),
}).strict();
export type ProjectGenerationCache = z.infer<typeof projectGenerationCacheSchema>;
