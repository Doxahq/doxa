import {
  hrefForSourcePath,
  matchPages,
  normalizeHref,
  type MatchablePage,
} from "@doxahq/docs-engine";
import type { StoredBranchChange } from "../../repositories/docs-branches";
import type { PageMove } from "../../repositories/page-locks";
import type { DocsContentStore } from "../docs-content/store";
import type { ContentStructure, ContentStructurePage } from "../docs-content/structure";
import { loadReviewTree, type ReviewTree } from "../generation-reviews/review-tree";

/** What a publication does to the routes of the live pages. */
export interface PublishedPageChanges {
  /** Pages that keep their text, or their title in their section, at a new route. */
  moves: PageMove[];
  /** Pages that the publication takes off the site. */
  removedHrefs: string[];
}

const NO_PAGE_CHANGES: PublishedPageChanges = { moves: [], removedHrefs: [] };

/**
 * The pages that a branch moves or removes, from the version it is based on
 * to the version it publishes. A move deletes the old page file, so a branch
 * that deletes no page file moves and removes nothing. Only pages whose route
 * changed are read and matched (see `matchPages`).
 */
export async function publishedPageChanges(
  store: Pick<DocsContentStore, "read" | "listKeys">,
  input: { baseArtifactPrefix: string; changes: readonly StoredBranchChange[] },
): Promise<PublishedPageChanges> {
  const deletesPage = input.changes.some(
    (change) => change.kind === "delete" && hrefForSourcePath(change.path) !== null,
  );
  if (!deletesPage) return NO_PAGE_CHANGES;

  const [base, next] = await Promise.all([
    loadReviewTree(store, input.baseArtifactPrefix),
    loadReviewTree(store, input.baseArtifactPrefix, input.changes),
  ]);
  const [gone, arrived] = await Promise.all([
    matchableOutside(base, next.structure),
    matchableOutside(next, base.structure),
  ]);
  const matching = matchPages(gone, arrived);

  return {
    moves: matching.matches.map(({ previous, current }) => ({ from: previous.href, to: current.href })),
    removedHrefs: matching.unmatchedPrevious.map((page) => page.href),
  };
}

/** The pages of `tree` whose routes `other` lacks, with their text. */
async function matchableOutside(tree: ReviewTree, other: ContentStructure): Promise<MatchablePage[]> {
  const otherHrefs = new Set(other.pages.map((page) => normalizeHref(page.href)));
  const pages = tree.structure.pages.filter((page) => !otherHrefs.has(normalizeHref(page.href)));
  return Promise.all(pages.map(async (page) => toMatchable(tree, page)));
}

async function toMatchable(tree: ReviewTree, page: ContentStructurePage): Promise<MatchablePage> {
  const href = normalizeHref(page.href);
  return {
    href,
    title: page.title,
    section: sectionOf(tree.structure, href),
    content: await tree.read(page.sourcePath),
  };
}

/** The slug of the section whose navigation lists `href`, or "" when none does. */
function sectionOf(structure: ContentStructure, href: string): string {
  const section = structure.sections.find((candidate) =>
    candidate.nodes.some((node) => hrefOfNode(node) === href)
  );
  return section?.slug ?? "";
}

function hrefOfNode(node: unknown): string | null {
  if (typeof node !== "object" || node === null || !("href" in node)) return null;
  return typeof node.href === "string" ? normalizeHref(node.href) : null;
}
