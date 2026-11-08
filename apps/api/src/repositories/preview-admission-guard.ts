import { schema, type DoxaDb } from "@doxahq/db";
import { eq } from "drizzle-orm";
import type { ChangeProposalLifecycleState } from "./change-proposals";

type GuardTransaction = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];

/**
 * Why the previews of a pull request stop: it was closed or merged, or it
 * moved to a base other than the production branch.
 */
export type PreviewStopReason =
  | Exclude<ChangeProposalLifecycleState, "open">
  | "retargeted";

/** Why an admission refuses a preview: its pull request stopped, or it got a newer head. */
export type PreviewAdmissionStop = PreviewStopReason | "superseded";

/** The fields of a pull request record that decide if a preview can start. */
export interface PreviewGateRecord {
  state: ChangeProposalLifecycleState;
  baseRef: string;
  headRevision: string;
  sourceUpdatedAt: Date;
}

/**
 * What the caller saw when it decided to start a preview. The admission
 * compares it with the record under a lock, so a close, a retarget or a newer
 * push that lands between the decision and the admission refuses the preview.
 */
export interface PreviewAdmissionGuard {
  /** The pull request record as the caller wrote it or read it. */
  seen: PreviewGateRecord;
  productionBranch: string;
}

/**
 * The reason to refuse the preview, or null. A record that is still as the
 * caller saw it never refuses: the caller already decided on it, for example
 * from the live pull request when the record was behind GitHub.
 */
export function previewAdmissionStop(
  current: PreviewGateRecord,
  guard: PreviewAdmissionGuard,
  targetRevision: string,
): PreviewAdmissionStop | null {
  if (sameRecord(current, guard.seen)) return null;
  if (current.state !== "open") return current.state;
  if (current.baseRef !== guard.productionBranch) return "retargeted";
  if (current.headRevision !== targetRevision) return "superseded";
  return null;
}

/**
 * Locks the pull request record until the transaction ends, then checks the
 * admission against it. Every write to the record waits for this lock. So a
 * close either lands first and refuses the preview here, or lands after the
 * commit and finds the admitted job when it cancels the active preview.
 */
export async function checkPreviewAdmission(
  transaction: GuardTransaction,
  input: {
    changeProposalId: string;
    targetRevision: string;
    guard: PreviewAdmissionGuard;
  },
): Promise<PreviewAdmissionStop | null> {
  const [current] = await transaction
    .select({
      state: schema.scmChangeProposals.state,
      baseRef: schema.scmChangeProposals.baseRef,
      headRevision: schema.scmChangeProposals.headRevision,
      sourceUpdatedAt: schema.scmChangeProposals.sourceUpdatedAt,
    })
    .from(schema.scmChangeProposals)
    .where(eq(schema.scmChangeProposals.id, input.changeProposalId))
    .for("update");
  if (!current) {
    throw new Error("The pull request record of the preview was not found.");
  }
  return previewAdmissionStop(current, input.guard, input.targetRevision);
}

function sameRecord(left: PreviewGateRecord, right: PreviewGateRecord): boolean {
  return (
    left.state === right.state &&
    left.baseRef === right.baseRef &&
    left.headRevision === right.headRevision &&
    left.sourceUpdatedAt.getTime() === right.sourceUpdatedAt.getTime()
  );
}
