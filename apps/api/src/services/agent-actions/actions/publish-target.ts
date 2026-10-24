/**
 * The approval request key of a branch publish. The publish action uses it
 * as its target key, and an agent branch delete looks it up to refuse while
 * a publish of that branch waits for a decision.
 */
export const DOCS_PUBLISH_ACTION_KIND = "docs.publish";

export function publishTargetKey(branchId: string): string {
  return `branch:${branchId}`;
}
