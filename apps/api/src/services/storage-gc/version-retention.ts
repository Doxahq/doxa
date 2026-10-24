import {
  isPreviewPromotable,
  keepsProductionVersion,
  type ProductionHistoryPosition,
  type RetentionPolicy,
} from "@doxahq/contracts/retention-policy";
import {
  RETAINED_BY_POLICY_RECHECK_SECONDS,
  type StorageGcInspection,
} from "@doxahq/contracts/storage-gc";

import { REFERENCED_PREVIEW_RECHECK_SECONDS } from "./collectors/docs-version-prefix";

/**
 * A live pointer to a version. The history of publications is not a
 * pointer: a version leaves it only through the retention policy.
 *
 * - `published`: the site serves the version.
 * - `preview_channel`: a preview hostname serves the version.
 * - `branch_base`: a branch builds on the version, and its publication
 *   inherits the version's generation state.
 * - `open_review`: an open generation review stages the version.
 * - `active_generation`: a queued or running generation reads the version as
 *   its baseline or seed, or writes it.
 */
export type VersionPointer =
  | "published"
  | "preview_channel"
  | "branch_base"
  | "open_review"
  | "active_generation";

/** The facts that decide whether one version row still needs its storage. */
export interface VersionRetentionFacts {
  channel: "production" | "preview";
  createdAt: Date;
  previewReplacedAt: Date | null;
  artifactsCollectedAt: Date | null;
  pointers: readonly VersionPointer[];
  /** Null for a version that production never published. */
  history: ProductionHistoryPosition | null;
  /** A succeeded generation points to the version, so Promote can use it. */
  hasSucceededGeneration: boolean;
}

export type VersionRetentionReason =
  | "version_is_referenced"
  | "rollback_window"
  | "promote_window";

/**
 * Why one version still needs its folder and its generation state, or null.
 *
 * A collected version keeps only its pointers: it is no longer restorable or
 * promotable, so the policy windows no longer apply to it.
 */
export function versionRetention(
  facts: VersionRetentionFacts,
  policy: RetentionPolicy,
  now: Date,
): VersionRetentionReason | null {
  if (facts.pointers.length > 0) return "version_is_referenced";
  if (facts.artifactsCollectedAt !== null) return null;

  if (facts.history && keepsProductionVersion(facts.history, policy, now)) {
    return "rollback_window";
  }

  if (
    facts.channel === "preview" &&
    facts.hasSucceededGeneration &&
    isPreviewPromotable(
      // A preview that no channel serves but that has no replacement time
      // lost its channel some other way; its age counts from its creation.
      { replacedAt: facts.previewReplacedAt ?? facts.createdAt },
      policy,
      now,
    )
  ) {
    return "promote_window";
  }

  return null;
}

/**
 * The decision for storage that several version rows share: a folder or a
 * generation state. The storage goes only when no row needs it.
 */
export function inspectSharedVersionStorage(
  rows: readonly VersionRetentionFacts[],
  policy: RetentionPolicy,
  now: Date,
): StorageGcInspection {
  const reasons = rows.flatMap((row) => {
    const reason = versionRetention(row, policy, now);
    return reason ? [reason] : [];
  });

  if (reasons.includes("version_is_referenced")) {
    return {
      status: "retain",
      reason: "version_is_referenced",
      recheckAfterSeconds: REFERENCED_PREVIEW_RECHECK_SECONDS,
    };
  }

  const [policyReason] = reasons;
  return policyReason
    ? {
        status: "retain",
        reason: policyReason,
        recheckAfterSeconds: RETAINED_BY_POLICY_RECHECK_SECONDS,
      }
    : { status: "collect" };
}
