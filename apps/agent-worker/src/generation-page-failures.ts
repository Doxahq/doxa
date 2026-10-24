import {
  isRunStoppingModelErrorMessage,
  type FailedStagePage,
} from "@doxahq/contracts";
import {
  GENERATION_PAGE_FLAGGED_EVENT_TYPE,
  type FlaggedPage,
  type FlaggedPageOutcome,
} from "@doxahq/contracts/generation-reviews";
import { z } from "zod";
import { GenerationNonRetryableError } from "./generation-errors";

/**
 * A run fails only when this share of the pages it had to write failed.
 * Below it, the run ends with the pages that it wrote and flags the rest
 * for the generation review.
 */
export const PAGE_FAILURE_RUN_THRESHOLD = 0.8;

export type FailedGenerationPage = FailedStagePage;

export interface FlaggedGenerationPage extends FailedGenerationPage {
  outcome: FlaggedPageOutcome;
}

export interface PageBatchOutcome {
  keys: string[];
  failedPages: FailedGenerationPage[];
}

export type SettledBatch<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/**
 * Joins the outcome of every write batch. A batch whose Workflow step failed
 * after its retries counts each of its pages as failed with that error.
 */
export function collectPageBatchOutcomes(
  batches: readonly (readonly string[])[],
  results: readonly SettledBatch<PageBatchOutcome>[],
  titleOf: (pageId: string) => string,
): PageBatchOutcome {
  const keys: string[] = [];
  const failedPages: FailedGenerationPage[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      keys.push(...result.value.keys);
      failedPages.push(...result.value.failedPages);
      return;
    }
    const reason = errorReason(result.reason);
    for (const pageId of batches[index] ?? []) {
      failedPages.push({ id: pageId, title: titleOf(pageId), reason });
    }
  });
  return { keys, failedPages };
}

export function isPageFailureBudgetExceeded(
  failedCount: number,
  plannedCount: number,
): boolean {
  return plannedCount > 0 && failedCount / plannedCount >= PAGE_FAILURE_RUN_THRESHOLD;
}

/** Fails the run when too many of its pages failed to keep a useful site. */
export function assertPageFailureBudget(
  failedPages: readonly FailedGenerationPage[],
  plannedCount: number,
): void {
  if (!isPageFailureBudgetExceeded(failedPages.length, plannedCount)) return;
  const examples = failedPages
    .slice(0, 3)
    .map((page) => `${page.title}: ${page.reason}`)
    .join("; ");
  throw new GenerationNonRetryableError(
    `${failedPages.length} of ${plannedCount} pages could not be written, ` +
      `so the run stopped instead of publishing an incomplete site. ${examples}`,
  );
}

const MAX_REASON_CHARS = 2_000;

function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "The page batch failed.").slice(0, MAX_REASON_CHARS);
}

interface PlanPageLists {
  regeneratePageIds: string[];
  reusePageIds: string[];
}

export interface PlanWithFailedPages<TPlan extends PlanPageLists> {
  plan: TPlan;
  flaggedPages: FlaggedGenerationPage[];
  /** Pages that the site leaves out, because no published page can stand in. */
  leftOutPageIds: ReadonlySet<string>;
}

/**
 * Moves each failed page out of the pages to regenerate. A failed page that
 * the baseline has keeps its published version, as a reused page; the
 * others are left out of the site. Both become flagged review pages.
 */
export function planWithFailedPages<TPlan extends PlanPageLists>(
  plan: TPlan,
  failedPages: readonly FailedGenerationPage[],
  baselinePageIds: ReadonlySet<string>,
): PlanWithFailedPages<TPlan> {
  const failedIds = new Set(failedPages.map((page) => page.id));
  const flaggedPages = failedPages.map((page): FlaggedGenerationPage => ({
    ...page,
    outcome: baselinePageIds.has(page.id) ? "kept_published" : "left_out",
  }));
  const kept = flaggedPages
    .filter((page) => page.outcome === "kept_published")
    .map((page) => page.id);
  return {
    plan: {
      ...plan,
      regeneratePageIds: plan.regeneratePageIds.filter((id) => !failedIds.has(id)),
      reusePageIds: [...plan.reusePageIds, ...kept.filter((id) => !plan.reusePageIds.includes(id))],
    },
    flaggedPages,
    leftOutPageIds: new Set(
      flaggedPages.filter((page) => page.outcome === "left_out").map((page) => page.id),
    ),
  };
}

const structureTitlesSchema = z.object({
  sections: z.array(z.object({
    id: z.string(),
    pages: z.array(z.object({ id: z.string(), title: z.string() })),
  })),
});

/**
 * Page titles by stable page ID (`{sectionId}/{pageId}`, as the agent's
 * `stablePageId` builds it) from a structure checkpoint. A failed batch has
 * no titles of its own, and the review shows titles, not IDs.
 */
export function pageTitlesFromStructure(checkpoint: string): (pageId: string) => string {
  const parsed = structureTitlesSchema.safeParse(safeJson(checkpoint));
  const titles = new Map<string, string>(
    parsed.success
      ? parsed.data.sections.flatMap((section) =>
          section.pages.map((page) => [`${section.id}/${page.id}`, page.title] as const)
        )
      : [],
  );
  return (pageId) => titles.get(pageId) ?? pageId;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Errors that end the whole run rather than one batch: the job was
 * cancelled or paused, the run used its overall time budget, or the model
 * provider refused the account.
 */
export function isRunStoppingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RUN_STOPPING_MESSAGE.test(message) || isRunStoppingModelErrorMessage(message);
}

const RUN_STOPPING_MESSAGE = /generation job is no longer active|generation is paused|overall budget/i;

/** One job event per flagged page, which the generation review lists. */
export async function recordFlaggedPages(input: {
  flaggedPages: readonly FlaggedGenerationPage[];
  /** The published route of a page that kept its published version. */
  routeOf: (pageId: string) => string | undefined;
  addJobEvent: (event: {
    type: string;
    message: string;
    source: "worker";
    data: FlaggedPage;
  }) => Promise<unknown>;
}): Promise<void> {
  for (const page of input.flaggedPages) {
    const data: FlaggedPage = {
      pageId: page.id,
      title: page.title,
      reason: page.reason,
      outcome: page.outcome,
      href: page.outcome === "kept_published" ? input.routeOf(page.id) ?? null : null,
    };
    await input.addJobEvent({
      type: GENERATION_PAGE_FLAGGED_EVENT_TYPE,
      message: page.outcome === "kept_published"
        ? `${page.title} could not be rewritten and keeps its published version.`
        : `${page.title} could not be written and is not in this version.`,
      source: "worker",
      data,
    });
  }
}
