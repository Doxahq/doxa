import {
  extractSeedConflicts,
  type GenerationReviewPageChange,
  type GenerationReviewPageDecision,
  type GenerationReviewReason,
} from "@doxahq/contracts/generation-reviews";
import { normalizeHref } from "@doxahq/docs-engine";
import { mapWithConcurrency } from "../../utils/concurrency";
import type { ReviewPages } from "./review-tree";

const READ_CONCURRENCY = 16;

/** One page that the generation changes, before a person decides on it. */
export interface ReviewPageDraft {
  href: string;
  title: string;
  change: GenerationReviewPageChange;
  reasons: GenerationReviewReason[];
}

/** Where a review page is on the review branch. */
export interface ReviewPageLocation {
  /** The href that the generation gave the page. It names the page in the review. */
  href: string;
  /** Where a person renamed or moved the page on the review branch, else null. */
  branchHref: string | null;
}

/** The page state that the review branch is built from. */
export interface ReviewPageState extends ReviewPageLocation {
  change: GenerationReviewPageChange;
  decision: GenerationReviewPageDecision;
}

/** The version of a page that the review branch shows, or null when the page leaves it. */
export type ReviewPageSource = "generated" | "published";

/** The href of a review page on the review branch. */
export function branchHrefOf(page: ReviewPageLocation): string {
  return page.branchHref ?? page.href;
}

/**
 * Lists the pages whose content or presence differs between the published
 * site and the generated site: generated pages first, in generated order,
 * then pages that only the published site has.
 */
export async function compareReviewTrees(
  main: ReviewPages,
  generated: ReviewPages,
): Promise<ReviewPageDraft[]> {
  const comparisons = await mapWithConcurrency(
    generated.structure.pages,
    READ_CONCURRENCY,
    async (page): Promise<ReviewPageDraft | null> => {
      const published = main.page(page.href);
      if (!published) {
        return draft(page, "added", { kind: "new_page" });
      }

      const [publishedSource, generatedSource] = await Promise.all([
        main.read(published.sourcePath),
        generated.read(page.sourcePath),
      ]);
      const generatedPage = extractSeedConflicts(generatedSource ?? "");
      if (publishedSource === generatedPage.content) return null;

      const modified = draft(page, "modified", { kind: "content_rewritten" });
      return generatedPage.conflicts.length > 0
        ? {
            ...modified,
            reasons: [
              ...modified.reasons,
              { kind: "seed_conflicts", items: generatedPage.conflicts },
            ],
          }
        : modified;
    },
  );
  const removed = main.structure.pages
    .filter((page) => generated.page(page.href) === null)
    .map((page) => draft(page, "removed", { kind: "missing_from_generation" }));

  return [
    ...comparisons.filter((page): page is ReviewPageDraft => page !== null),
    ...removed,
  ];
}

/**
 * The decision every page starts with: the change that the generation made,
 * a removal and a page that a person owns included. A person who trusts the
 * run publishes the review as it is. A person who does not reviews it.
 */
export const INITIAL_DECISION: GenerationReviewPageDecision = "accepted";

/** A decision that a person already made, to carry to a newer run. */
export interface PriorReviewPage extends ReviewPageLocation {
  change: GenerationReviewPageChange;
  decision: GenerationReviewPageDecision;
  decidedAt: Date | null;
  decidedByUserId?: string | null;
}

/** A page of a run, with the decision it starts with. */
export interface ReviewPagePlan extends ReviewPageDraft {
  branchHref: string | null;
  decision: GenerationReviewPageDecision;
  decidedAt: Date | null;
  decidedByUserId: string | null;
}

/** What a run knows about the pages before a person decides. */
export interface RunPageContext {
  /** Pages that a person locked. */
  lockedHrefs?: ReadonlySet<string>;
  /** The source files behind each page that the run wrote, by href. */
  sourcesByHref?: ReadonlyMap<string, readonly string[]>;
}

/**
 * The pages of a run. A decision carries over while the page changes in the
 * same way; a different change is a new question for the person. So does the
 * href that a person moved the page to on the review branch. Every other
 * page starts with the generation's change. A page that a person locked says
 * so in its reasons. Each written page cites the source files behind it.
 */
export function planRunPages(
  drafts: readonly ReviewPageDraft[],
  prior: readonly PriorReviewPage[],
  context: RunPageContext = {},
): ReviewPagePlan[] {
  const priorByHref = new Map(prior.map((page) => [page.href, page]));

  return drafts.map((draft) => {
    const cited = withSources(draft, context.sourcesByHref?.get(draft.href));
    const previous = priorByHref.get(draft.href);
    const sameChange = previous?.change === draft.change;
    const branchHref = sameChange ? previous.branchHref : null;
    if (sameChange && previous.decidedAt !== null) {
      return {
        ...cited,
        branchHref,
        decision: previous.decision,
        decidedAt: previous.decidedAt,
        decidedByUserId: previous.decidedByUserId ?? null,
      };
    }

    const locked =
      draft.change !== "added" && Boolean(context.lockedHrefs?.has(draft.href));
    const reasons: GenerationReviewReason[] = locked
      ? [...cited.reasons, { kind: "owned_by_person" }]
      : cited.reasons;
    return {
      ...cited,
      branchHref,
      reasons,
      decision: INITIAL_DECISION,
      decidedAt: null,
      decidedByUserId: null,
    };
  });
}

function withSources(
  draft: ReviewPageDraft,
  paths: readonly string[] | undefined,
): ReviewPageDraft {
  if (!paths || paths.length === 0 || draft.change === "removed") return draft;
  return {
    ...draft,
    reasons: [...draft.reasons, { kind: "based_on_sources", paths: [...paths] }],
  };
}

/** True when the page of this state is part of the reviewed site. */
export function keepsGeneratedPage(page: ReviewPageState): boolean {
  return page.change !== "removed" && page.decision !== "rejected";
}

/** True when the published page stays, whatever the generation did to it. */
export function keepsPublishedPage(page: ReviewPageState): boolean {
  return page.change === "removed" && page.decision !== "accepted";
}

/**
 * The version of the page that the review branch shows for its decision:
 * the generated page, the published page, or none for a new page that the
 * person skipped and a removal that the person accepted.
 */
export function reviewPageSource(page: ReviewPageState): ReviewPageSource | null {
  if (keepsGeneratedPage(page)) return "generated";
  if (page.change === "added") return null;
  if (page.change === "removed") return keepsPublishedPage(page) ? "published" : null;
  return "published";
}

function draft(
  page: { href: string; title: string },
  change: GenerationReviewPageChange,
  reason: GenerationReviewReason,
): ReviewPageDraft {
  return {
    href: normalizeHref(page.href),
    title: page.title,
    change,
    reasons: [reason],
  };
}
