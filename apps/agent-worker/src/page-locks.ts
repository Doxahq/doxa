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

type PlanOwnedPageFlag = NonNullable<IncrementalGenerationPlan["ownedPageFlags"]>[number];

/**
 * Keeps the pages that a person locked. A locked page that the plan would
 * rewrite is reused instead. It is flagged when its sources changed, or in
 * the run where the project instructions changed, so the review can ask the
 * person to look once. A locked page that only catches up with older
 * instructions is kept without a flag, so it never opens a review by itself.
 * A locked page that the new plan has no page for stays removed and is
 * flagged too: a plan cannot keep a page outside its structure. A page needs
 * a baseline state to be reused, so a locked page without one is left in
 * the plan.
 */
export function applyPageLocks(input: {
  plan: IncrementalGenerationPlan;
  statePages: readonly GenerationPageState[];
  lockedHrefs: ReadonlySet<string>;
  changedPaths: ReadonlySet<string>;
  /** This run's instructions differ from the published run's. */
  instructionsChanged: boolean;
}): IncrementalGenerationPlan {
  const stateById = new Map(input.statePages.map((page) => [page.pageId, page]));
  const isLocked = (pageId: string) => {
    const state = stateById.get(pageId);
    return state !== undefined && input.lockedHrefs.has(normalizeHref(state.route));
  };
  const kept = input.plan.regeneratePageIds.filter(isLocked);
  const removed = input.plan.removedPageIds.filter(isLocked);
  if (kept.length === 0 && removed.length === 0) return input.plan;

  const ownedPageFlags = [
    ...kept.flatMap((pageId) => keptPageFlag(pageId, stateById.get(pageId), input)),
    ...removed.map((pageId): PlanOwnedPageFlag => ({ pageId, changedPaths: [], removed: true })),
  ];
  const withFlags = (plan: IncrementalGenerationPlan): IncrementalGenerationPlan =>
    ownedPageFlags.length > 0 ? { ...plan, ownedPageFlags } : plan;
  if (kept.length === 0) return withFlags(input.plan);

  const keptIds = new Set(kept);
  const regeneratePageIds = input.plan.regeneratePageIds.filter((pageId) => !keptIds.has(pageId));
  // The causes classify the planner's own decisions. Locks change the page
  // lists after them, so the plan drops the causes and its page edits.
  const { causes: _causes, pageEdits, catchUpPageIds, ...plan } = input.plan;
  const remainingEdits = pageEdits
    ? Object.fromEntries(Object.entries(pageEdits).filter(([pageId]) => !keptIds.has(pageId)))
    : undefined;
  const remainingCatchUp = catchUpPageIds?.filter((pageId) => !keptIds.has(pageId));

  return withFlags({
    ...plan,
    regeneratePageIds,
    reusePageIds: [...input.plan.reusePageIds, ...kept],
    modelCallsRequired: regeneratePageIds.length > 0,
    reasons: [...input.plan.reasons, `Kept ${kept.length} page(s) that a person locked.`],
    ...(remainingEdits && Object.keys(remainingEdits).length > 0 ? { pageEdits: remainingEdits } : {}),
    ...(remainingCatchUp && remainingCatchUp.length > 0 ? { catchUpPageIds: remainingCatchUp } : {}),
  });
}

/** The flag of a kept locked page, or none when nothing behind it changed. */
function keptPageFlag(
  pageId: string,
  state: GenerationPageState | undefined,
  input: { changedPaths: ReadonlySet<string>; instructionsChanged: boolean },
): PlanOwnedPageFlag[] {
  const changedPaths = state
    ? dependencyPaths(state.dependencies).filter((path) => input.changedPaths.has(path)).slice(0, MAX_FLAG_PATHS)
    : [];
  const { instructionsChanged } = input;
  if (changedPaths.length === 0 && !instructionsChanged) return [];
  return [{ pageId, changedPaths, ...(instructionsChanged ? { instructionsChanged: true as const } : {}) }];
}

/** The review flags of a plan, with the route and title of each locked page. */
export function lockedPageFlagsOf(
  plan: IncrementalGenerationPlan,
  statePages: readonly GenerationPageState[],
): OwnedPageFlag[] {
  const stateById = new Map(statePages.map((page) => [page.pageId, page]));
  return (plan.ownedPageFlags ?? []).flatMap((flag) => {
    const state = stateById.get(flag.pageId);
    return state
      ? [{
          href: normalizeHref(state.route),
          title: state.title,
          changedPaths: flag.changedPaths,
          ...(flag.instructionsChanged ? { instructionsChanged: true as const } : {}),
          ...(flag.removed ? { removed: true as const } : {}),
        }]
      : [];
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
