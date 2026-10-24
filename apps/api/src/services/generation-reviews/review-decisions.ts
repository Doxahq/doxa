import {
  extractSeedConflicts,
  type GenerationReviewPageDecision,
} from "@doxahq/contracts/generation-reviews";
import { normalizeHref } from "@doxahq/docs-engine";
import { DocsContentError } from "../docs-content/errors";
import {
  applyStructureEdit,
  restoreStructurePage,
  setStructurePageTitle,
  type ContentStructure,
  type ContentStructurePage,
} from "../docs-content/structure";
import type { DesiredChange } from "../docs-branches/working-changes";
import { structureArtifactFiles } from "./review-changes";
import { hasPage } from "./review-moves";
import {
  branchHrefOf,
  reviewPageSource,
  type ReviewPageSource,
  type ReviewPageState,
} from "./review-pages";
import type { ReviewTree } from "./review-tree";

/** A review page with the decision that a person just made on it. */
export interface DecidedReviewPage extends ReviewPageState {
  /** The decision before this one, which says whether the branch has the page now. */
  previousDecision: GenerationReviewPageDecision;
}

export interface BranchDecisionInput {
  /** The review branch as it is now, with every edit a person made on it. */
  branch: ReviewTree;
  /** The published version that the branch is based on. */
  main: ReviewTree;
  generated: ReviewTree;
  pages: readonly DecidedReviewPage[];
  /** True when a person edited the file at this path on the branch. */
  isPersonEdit: (path: string) => boolean;
}

export interface BranchDecisionResult {
  /** The working files that apply the decisions. */
  desired: Map<string, DesiredChange>;
  /**
   * The new branch href of each decided page that a decision put back at
   * its own href or took off the branch. Null stores "at its own href".
   */
  branchHrefs: Map<string, string | null>;
  /** The review hrefs of the pages that a decision took off the branch with a person's edits. */
  droppedEdits: string[];
}

/**
 * Applies decisions to the review branch as it is now. Each decision
 * changes its own page, wherever a person moved it, and nothing else: a
 * rename, a move, or another edit that a person made on the branch stays.
 *
 * A decision that keeps a page on the branch updates its title and body,
 * unless a person edited the body. A decision that takes the page off the
 * branch removes it, edits included, and names it in `droppedEdits`. A decision that brings a page back
 * restores it where the generated or published site has it.
 */
export async function applyDecisionsToBranch(
  input: BranchDecisionInput,
): Promise<BranchDecisionResult> {
  const desired = new Map<string, DesiredChange>();
  const branchHrefs = new Map<string, string | null>();
  const droppedEdits: string[] = [];
  let structure = input.branch.structure;

  for (const page of input.pages) {
    const at = branchHrefOf(page);
    // A page that an earlier decision took off the branch is absent, even
    // when another page took its href since.
    const present = isOnBranch(page) && hasPage(structure, at);
    const source = reviewPageSource(page);

    if (source === null) {
      if (present) {
        if (await hasPersonEdits(input, page, requirePage(structure, at))) droppedEdits.push(page.href);
        structure = removePage(structure, at, desired);
      }
      if (page.branchHref !== null) branchHrefs.set(page.href, null);
      continue;
    }

    const version = sourceVersion(input, source, page.href);
    if (!present) {
      structure = await restorePage(structure, version, page.href, desired);
      if (page.branchHref !== null) branchHrefs.set(page.href, null);
      continue;
    }

    const branchPage = requirePage(structure, at);
    if (!input.isPersonEdit(branchPage.sourcePath)) {
      structure = setStructurePageTitle(structure, at, version.page.title);
      desired.set(branchPage.sourcePath, await version.body());
    }
  }

  for (const [path, content] of structureArtifactFiles(structure, input.branch)) {
    desired.set(path, content);
  }

  return { desired, branchHrefs, droppedEdits };
}

function isOnBranch(page: DecidedReviewPage): boolean {
  return reviewPageSource({ ...page, decision: page.previousDecision }) !== null;
}

/** One version of a review page: the generated page or the published page. */
interface PageVersion {
  tree: ReviewTree;
  page: ContentStructurePage;
  body: () => Promise<string>;
}

function sourceVersion(
  input: BranchDecisionInput,
  source: ReviewPageSource,
  href: string,
): PageVersion {
  const tree = source === "generated" ? input.generated : input.main;
  const page = tree.page(href);
  if (!page) {
    throw new DocsContentError(
      "invalid",
      `The ${source} page at ${href} could not be read.`,
    );
  }

  return {
    tree,
    page,
    body: async () => {
      const body = await tree.read(page.sourcePath);
      if (body === null) {
        throw new DocsContentError(
          "invalid",
          `The ${source} page at ${href} could not be read.`,
        );
      }
      // The conflicts of a seeded writer belong in the review, not the page.
      return source === "generated" ? extractSeedConflicts(body).content : body;
    },
  };
}

/**
 * True when a person changed the text of a page that a decision takes off
 * the branch: it differs from the version that put the page on the branch,
 * the generated page or the published page. A rename alone loses nothing.
 */
async function hasPersonEdits(
  input: BranchDecisionInput,
  page: DecidedReviewPage,
  branchPage: ContentStructurePage,
): Promise<boolean> {
  if (!input.isPersonEdit(branchPage.sourcePath)) return false;
  const origin = sourceVersion(input, page.change === "added" ? "generated" : "published", page.href);
  return (await input.branch.read(branchPage.sourcePath)) !== (await origin.body());
}

function removePage(
  structure: ContentStructure,
  href: string,
  desired: Map<string, DesiredChange>,
): ContentStructure {
  const sourcePath = requirePage(structure, href).sourcePath;
  desired.set(sourcePath, null);
  return applyStructureEdit(structure, { type: "delete_page", href }).structure;
}

/**
 * Puts the page back at its own href. A page that a person moved since and
 * took off the branch comes back where the version has it.
 */
async function restorePage(
  structure: ContentStructure,
  version: PageVersion,
  href: string,
  desired: Map<string, DesiredChange>,
): Promise<ContentStructure> {
  if (hasPage(structure, href)) {
    throw new DocsContentError(
      "conflict",
      `Another page uses ${href} on the review branch. Rename that page, then decide again.`,
    );
  }

  const restored = restoreStructurePage(structure, version.tree.structure, href);
  desired.set(version.page.sourcePath, await version.body());
  return restored;
}

function requirePage(structure: ContentStructure, href: string): ContentStructurePage {
  const target = normalizeHref(href);
  const page = structure.pages.find((entry) => normalizeHref(entry.href) === target);
  if (!page) {
    throw new DocsContentError("not_found", `No page exists at ${href}.`);
  }

  return page;
}
