import { normalizeHref } from "@doxahq/docs-engine";
import {
  applyStructureEdit,
  restoreStructurePage,
  type ContentStructure,
} from "../docs-content/structure";
import {
  reviewPageSource,
  type ReviewPageLocation,
  type ReviewPagePlan,
} from "./review-pages";
import type { ReviewTree } from "./review-tree";

/** A review page that a person renamed or moved on the review branch. */
export type ReviewPageMove = ReviewPageLocation & { branchHref: string };

export interface MovedPagePlacement {
  structure: ContentStructure;
  /** The pages of the run, with the moves that still hold. */
  pages: ReviewPagePlan[];
  /** The moves that no longer hold. Their pages go back to their own href. */
  released: ReviewPageMove[];
}

/**
 * Keeps the pages that a person renamed or moved on the review branch where
 * the person put them, when a newer run rebuilds the review navigation. A
 * move holds while the run keeps the page and the target href is free. The
 * other moves are released, also for pages that the run no longer changes.
 */
export function placeMovedPages(input: {
  /** The navigation that the run builds, with the decisions applied. */
  structure: ContentStructure;
  /** The review branch before the run, or null for a new review. */
  branch: ReviewTree | null;
  pages: readonly ReviewPagePlan[];
  prior: readonly ReviewPageLocation[];
}): MovedPagePlacement {
  let structure = input.structure;
  const released: ReviewPageMove[] = [];
  const pages = input.pages.map((page) => {
    if (page.branchHref === null) return page;

    const move = { href: page.href, branchHref: page.branchHref };
    if (!input.branch || !canHoldMove(structure, input.branch, page, move)) {
      released.push(move);
      return { ...page, branchHref: null };
    }

    structure = movePage(structure, input.branch.structure, move);
    return page;
  });

  const planned = new Set(input.pages.map((page) => page.href));
  for (const page of input.prior) {
    if (page.branchHref !== null && !planned.has(page.href)) {
      released.push({ href: page.href, branchHref: page.branchHref });
    }
  }

  return { structure, pages, released };
}

function canHoldMove(
  structure: ContentStructure,
  branch: ReviewTree,
  page: ReviewPagePlan,
  move: ReviewPageMove,
): boolean {
  return (
    reviewPageSource(page) !== null &&
    hasPage(structure, move.href) &&
    !hasPage(structure, move.branchHref) &&
    branch.page(move.branchHref) !== null
  );
}

/** Takes the page out of its generated place and puts it where the branch has it. */
function movePage(
  structure: ContentStructure,
  branch: ContentStructure,
  move: ReviewPageMove,
): ContentStructure {
  const withoutPage = applyStructureEdit(structure, {
    type: "delete_page",
    href: move.href,
  }).structure;
  return restoreStructurePage(withoutPage, branch, move.branchHref);
}

export function hasPage(structure: ContentStructure, href: string): boolean {
  const target = normalizeHref(href);
  return structure.pages.some((page) => normalizeHref(page.href) === target);
}
