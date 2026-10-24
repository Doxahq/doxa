import {
  GENERATION_RESUME_WINDOW_DAYS,
  type GenerationActionBlockedReason,
  type GenerationActionsDto,
  type GenerationJobDto,
  type WorkflowStepFailure,
} from "@doxahq/contracts";
import {
  isPreviewPromotable,
  type RetentionPolicy,
} from "@doxahq/contracts/retention-policy";

export interface GenerationActionFacts {
  status: GenerationJobDto["status"];
  docsVersionId: string | null;
  publishedVersionId: string | null;
  isServingProduction?: boolean;
  isServingPreview?: boolean;
  /** A production run whose version waits in a generation review. */
  awaitsReview?: boolean;
  publicationMode?: "production" | "preview";
  /** A newer run for the same pull request replaced this preview run. */
  isSuperseded?: boolean;
  /** Where the pull request of a preview run stands. */
  changeState?: "open" | "closed" | "merged" | null;
  /** The retention policy deleted the files of the run's version. */
  versionCollected?: boolean;
  /** A newer push replaced the preview longer ago than the policy allows. */
  promoteExpired?: boolean;
  /** The step that ended a failed run, when the workflow recorded one. */
  failedStep?: WorkflowStepFailure | null;
  /** When the run failed at that step. */
  failedAt?: Date | null;
  now?: Date;
}

/** The retention fields of a run's version that decide whether Promote works. */
export interface VersionRetentionState {
  channel: "production" | "preview";
  previewReplacedAt: Date | null;
  artifactsCollectedAt: Date | null;
}

/**
 * The retention facts of Promote. A promotion serves the files of the run's
 * version, so a collected version cannot be promoted. A replaced pull
 * request preview stays promotable only for the policy's promote window.
 */
export function promoteRetentionFacts(
  version: VersionRetentionState | null,
  policy: RetentionPolicy,
  now: Date,
): Pick<GenerationActionFacts, "versionCollected" | "promoteExpired"> {
  if (!version) return { versionCollected: false, promoteExpired: false };
  return {
    versionCollected: version.artifactsCollectedAt !== null,
    promoteExpired:
      version.channel === "preview" &&
      !isPreviewPromotable(
        { replacedAt: version.previewReplacedAt },
        policy,
        now,
      ),
  };
}

/**
 * The generation review of a run. Null when the run has none, or when a
 * newer run took its open review over.
 */
export interface GenerationRunReview {
  status: "open" | "published" | "discarded";
  /** The version that publishing the review made. */
  publishedVersionId: string | null;
}

/**
 * True while a production run waits in its open generation review, which
 * publishes it. Promote would skip that review. Its version stays staged
 * after the review closes, so the review says when the wait ends.
 */
export function awaitsGenerationReview(input: {
  publicationMode: "production" | "preview";
  versionStatus: "staged" | "published" | "failed" | null;
  review: GenerationRunReview | null;
}): boolean {
  return (
    input.publicationMode === "production" &&
    input.versionStatus === "staged" &&
    input.review?.status === "open"
  );
}

export function getPromoteBlockedReason(
  facts: GenerationActionFacts,
): GenerationActionBlockedReason | null {
  if (facts.status !== "succeeded") return "not_succeeded";
  if (!facts.docsVersionId) return "no_docs_version";
  if (facts.awaitsReview) return "review_required";
  if (
    facts.isServingProduction ||
    facts.docsVersionId === facts.publishedVersionId
  ) {
    return "already_production";
  }
  if (facts.versionCollected) return "version_collected";
  if (facts.promoteExpired) return "promote_expired";
  return null;
}

export function getDeleteBlockedReason(
  facts: GenerationActionFacts,
): GenerationActionBlockedReason | null {
  if (facts.status === "queued" || facts.status === "running") {
    return "in_progress";
  }
  if (
    facts.isServingProduction ||
    (facts.docsVersionId &&
      facts.docsVersionId === facts.publishedVersionId)
  ) {
    return "serving_production";
  }
  if (facts.isServingPreview) return "serving_preview";
  return null;
}

/**
 * A run can run again after it ends: failed, cancelled, or succeeded. A
 * production run builds the default branch as it is now. A preview run builds
 * its pull request's head, so it needs the pull request open and no newer run
 * for it.
 */
export function getRerunBlockedReason(
  facts: Pick<GenerationActionFacts, "status" | "publicationMode" | "isSuperseded" | "changeState">,
): GenerationActionBlockedReason | null {
  if (facts.status === "queued" || facts.status === "running") return "not_finished";
  if (facts.publicationMode !== "preview") return null;
  if (facts.isSuperseded) return "superseded";
  if (facts.changeState && facts.changeState !== "open") return "change_not_open";
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * A failed run continues from its failed step when the workflow recorded a
 * failure that a second try can fix, and its saved steps still exist. A
 * preview follows the same rules as a re-run.
 */
export function getResumeBlockedReason(
  facts: Pick<
    GenerationActionFacts,
    "status" | "publicationMode" | "isSuperseded" | "changeState" | "failedStep" | "failedAt" | "now"
  >,
): GenerationActionBlockedReason | null {
  if (facts.status !== "failed") return "not_resumable";
  if (!facts.failedStep?.resumable || !facts.failedAt) return "not_resumable";
  const now = facts.now ?? new Date();
  if (now.getTime() - facts.failedAt.getTime() > GENERATION_RESUME_WINDOW_DAYS * DAY_MS) {
    return "not_resumable";
  }
  return getRerunBlockedReason(facts);
}

export function resolveGenerationActions(
  facts: GenerationActionFacts,
): GenerationActionsDto {
  const promoteBlockedReason = getPromoteBlockedReason(facts);
  const deleteBlockedReason = getDeleteBlockedReason(facts);
  const rerunBlockedReason = getRerunBlockedReason(facts);
  const resumeBlockedReason = getResumeBlockedReason(facts);
  return {
    canPromote: promoteBlockedReason === null,
    canDelete: deleteBlockedReason === null,
    canRerun: rerunBlockedReason === null,
    canResume: resumeBlockedReason === null,
    promoteBlockedReason,
    deleteBlockedReason,
    rerunBlockedReason,
    resumeBlockedReason,
  };
}
