import type {
  GenerationExecutionContext,
  GenerationPageState,
  IncrementalGenerationPlan,
  PageDependencyState,
  SourceChange,
} from "@doxahq/contracts";
import type { OwnedPageFlag } from "@doxahq/contracts/generation-reviews";
import { normalizeHref } from "@doxahq/docs-engine";

const MAX_FLAG_PATHS = 20;

/** The live routes of the pages that a person locked against generations. */
export function lockedHrefsOf(context: Pick<GenerationExecutionContext, "pageLocks">): ReadonlySet<string> {
  return new Set((context.pageLocks?.locked ?? []).map(normalizeHref));
}

/**
 * Keeps the pages that a person locked. A locked page that the plan would
 * rewrite is reused instead, and flagged when its sources changed, so the
 * review can ask the person to look. A page needs a baseline state to be
 * reused, so a locked page without one is left in the plan.
 */
export function applyPageLocks(input: {
  plan: IncrementalGenerationPlan;
  statePages: readonly GenerationPageState[];
  lockedHrefs: ReadonlySet<string>;
  changedPaths: ReadonlySet<string>;
}): IncrementalGenerationPlan {
  const stateById = new Map(input.statePages.map((page) => [page.pageId, page]));
  const kept = input.plan.regeneratePageIds.filter((pageId) => {
    const state = stateById.get(pageId);
    return state !== undefined && input.lockedHrefs.has(normalizeHref(state.route));
  });
  if (kept.length === 0) return input.plan;

  const keptIds = new Set(kept);
  const regeneratePageIds = input.plan.regeneratePageIds.filter((pageId) => !keptIds.has(pageId));
  const ownedPageFlags = kept.flatMap((pageId) => {
    const state = stateById.get(pageId);
    const changedPaths = state
      ? dependencyPaths(state.dependencies).filter((path) => input.changedPaths.has(path))
      : [];
    return changedPaths.length > 0 ? [{ pageId, changedPaths: changedPaths.slice(0, MAX_FLAG_PATHS) }] : [];
  });
  // The causes classify the planner's own decisions. Locks change the page
  // lists after them, so the plan drops the causes and its page edits.
  const { causes: _causes, pageEdits, ...plan } = input.plan;
  const remainingEdits = pageEdits
    ? Object.fromEntries(Object.entries(pageEdits).filter(([pageId]) => !keptIds.has(pageId)))
    : undefined;

  return {
    ...plan,
    regeneratePageIds,
    reusePageIds: [...input.plan.reusePageIds, ...kept],
    modelCallsRequired: regeneratePageIds.length > 0,
    reasons: [...input.plan.reasons, `Kept ${kept.length} page(s) that a person locked.`],
    ...(remainingEdits && Object.keys(remainingEdits).length > 0 ? { pageEdits: remainingEdits } : {}),
    ...(ownedPageFlags.length > 0 ? { ownedPageFlags } : {}),
  };
}

/** The review flags of a plan, with the route and title of each locked page. */
export function lockedPageFlagsOf(
  plan: IncrementalGenerationPlan,
  statePages: readonly GenerationPageState[],
): OwnedPageFlag[] {
  const stateById = new Map(statePages.map((page) => [page.pageId, page]));
  return (plan.ownedPageFlags ?? []).flatMap((flag) => {
    const state = stateById.get(flag.pageId);
    return state ? [{ href: normalizeHref(state.route), title: state.title, changedPaths: flag.changedPaths }] : [];
  });
}

/** Every path of a snapshot change, renames included. */
export function changedSourcePaths(changes: readonly SourceChange[]): Set<string> {
  return new Set(
    changes.flatMap((change) => (change.previousPath ? [change.path, change.previousPath] : [change.path])),
  );
}

/** The files a page read, as the planner counts them for dependencies. */
function dependencyPaths(dependencies: PageDependencyState): string[] {
  return [...dependencies.sourceFilesRead, ...dependencies.sourceFilesDiscovered, ...dependencies.sourceEvidenceFiles];
}
