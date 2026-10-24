import { z } from "zod";

/**
 * How long Doxa keeps the derived storage of a project.
 *
 * Every value lives here, so a plan can override any of them later. The
 * collectors and the Promote rule read the policy through the API resolver
 * `resolveRetentionPolicy`, never through these constants, and they apply it
 * when they inspect a resource, not when they enqueue it. A plan change
 * therefore needs no data migration.
 */
export interface RetentionPolicy {
  /** Production versions that stay restorable. Either rule keeps a version. */
  productionHistory: {
    /** The newest published production versions that stay restorable. */
    keepLatest: number;
    /** Days after its last publication that a version stays restorable. */
    keepDays: number;
  };
  /** Days that a replaced pull request preview stays promotable. */
  previewPromoteDays: number;
}

export const DEFAULT_RETENTION_POLICY = {
  productionHistory: { keepLatest: 20, keepDays: 90 },
  previewPromoteDays: 7,
} as const satisfies RetentionPolicy;

const positiveCount = z.number().int().positive().max(10_000);

/** Plan overrides. Every field is optional and falls back to the default. */
export const retentionPolicyOverridesSchema = z
  .object({
    productionHistory: z
      .object({
        keepLatest: positiveCount.optional(),
        keepDays: positiveCount.optional(),
      })
      .strict()
      .optional(),
    previewPromoteDays: positiveCount.optional(),
  })
  .strict();

export type RetentionPolicyOverrides = z.infer<
  typeof retentionPolicyOverridesSchema
>;

export function mergeRetentionPolicy(
  base: RetentionPolicy,
  overrides: RetentionPolicyOverrides | null | undefined,
): RetentionPolicy {
  return {
    productionHistory: {
      keepLatest:
        overrides?.productionHistory?.keepLatest ??
        base.productionHistory.keepLatest,
      keepDays:
        overrides?.productionHistory?.keepDays ??
        base.productionHistory.keepDays,
    },
    previewPromoteDays:
      overrides?.previewPromoteDays ?? base.previewPromoteDays,
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Where a published production version stands in the site history. */
export interface ProductionHistoryPosition {
  /** 1 for the newest published production version of the site. */
  rank: number;
  /** The newest publication of the version, a restore included. */
  lastPublishedAt: Date;
}

/**
 * True while the policy keeps a production version restorable: it is one of
 * the newest `keepLatest` versions, or it was published in the last
 * `keepDays` days. Either rule keeps it.
 */
export function keepsProductionVersion(
  position: ProductionHistoryPosition,
  policy: RetentionPolicy,
  now: Date,
): boolean {
  const { keepLatest, keepDays } = policy.productionHistory;
  return (
    position.rank <= keepLatest ||
    now.getTime() - position.lastPublishedAt.getTime() < keepDays * DAY_MS
  );
}

/**
 * True while a pull request preview can still be promoted. A preview that
 * no newer push replaced has no replacement time and stays promotable.
 */
export function isPreviewPromotable(
  preview: { replacedAt: Date | null },
  policy: RetentionPolicy,
  now: Date,
): boolean {
  return (
    preview.replacedAt === null ||
    now.getTime() - preview.replacedAt.getTime() <
      policy.previewPromoteDays * DAY_MS
  );
}
