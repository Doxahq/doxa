import { listPlanRemovals, type PlanRemoval } from "@doxahq/agent";

export const PLAN_REMOVALS_EVENT_TYPE = "structure_pages_removed_by_instructions";

export interface PlanRemovalsLogEvent {
  type: typeof PLAN_REMOVALS_EVENT_TYPE;
  message: string;
  /** Flat fields, so that the generation log shows each one in full. */
  data: {
    removedPageCount: number;
    pageTypeCount: number;
    excludedEvidenceCount: number;
  };
}

/**
 * The log line that names the planned pages that the project instructions
 * removed, so a page never goes without a trace. Null when none went.
 */
export function planRemovalsLogEvent(removed: readonly PlanRemoval[]): PlanRemovalsLogEvent | null {
  if (removed.length === 0) return null;
  return {
    type: PLAN_REMOVALS_EVENT_TYPE,
    message: `Left out ${removed.length} planned ${removed.length === 1 ? "page" : "pages"} ` +
      `that the project instructions rule out: ${listPlanRemovals(removed)}.`,
    data: {
      removedPageCount: removed.length,
      pageTypeCount: removed.filter(({ reason }) => reason.kind === "page_type").length,
      excludedEvidenceCount: removed.filter(({ reason }) => reason.kind === "excluded_evidence").length,
    },
  };
}
