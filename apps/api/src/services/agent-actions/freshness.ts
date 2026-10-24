/**
 * Pure freshness comparisons (spec 8.8). Each action reads the current
 * state, then asks one of these functions whether its snapshot still holds.
 */
export type StaleReason =
  | "branch_gone"
  | "revision_changed"
  | "branch_behind"
  | "main_moved"
  | "domain_gone"
  | "project_gone"
  | "generation_active";

export type Freshness =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly reason: StaleReason; readonly message: string };

export const FRESH: Freshness = { fresh: true };

function stale(reason: StaleReason, message: string): Freshness {
  return { fresh: false, reason, message };
}

export interface PublishSnapshotFields {
  readonly baseVersionId: string;
  readonly revision: number;
}

export interface PublishCurrentState {
  readonly baseVersionId: string;
  readonly revision: number;
  readonly mainVersionId: string;
}

export function publishFreshness(
  snapshot: PublishSnapshotFields,
  current: PublishCurrentState | null,
): Freshness {
  if (current === null) return stale("branch_gone", "The branch no longer exists.");
  if (current.revision !== snapshot.revision) {
    return stale("revision_changed", "The branch changed after the request.");
  }
  if (
    current.baseVersionId !== snapshot.baseVersionId ||
    current.mainVersionId !== snapshot.baseVersionId
  ) {
    return stale("branch_behind", "The live site changed. Synchronize the branch first.");
  }
  return FRESH;
}

export function restoreFreshness(
  expectedMainVersionId: string,
  currentMainVersionId: string | null,
): Freshness {
  return currentMainVersionId === expectedMainVersionId
    ? FRESH
    : stale("main_moved", "The live site changed after the request.");
}

export function domainFreshness(domainExists: boolean): Freshness {
  return domainExists ? FRESH : stale("domain_gone", "The domain no longer exists.");
}

export function projectFreshness(projectExists: boolean): Freshness {
  return projectExists ? FRESH : stale("project_gone", "The project no longer exists.");
}

export function generationFreshness(generationActive: boolean): Freshness {
  return generationActive
    ? stale("generation_active", "A generation started after the request.")
    : FRESH;
}
