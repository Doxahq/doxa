import { extractSeedConflicts } from "@doxahq/contracts/generation-reviews";
import { normalizeHref } from "@doxahq/docs-engine";
import type { DocsContentStore } from "../docs-content/store";
import {
  contentStructureFromArtifacts,
  type ContentStructure,
  type ContentStructurePage,
} from "../docs-content/structure";
import {
  EffectiveTree,
  type EffectiveTreeChange,
} from "../docs-branches/effective-tree";

export const SITE_CONFIG_PATH = "settings/site.json";

/** One version of a site, as the review reads it: structure plus files. */
export interface ReviewTree {
  readonly structure: ContentStructure;
  /** The raw navigation files, keyed by section slug. */
  readonly sectionSlugs: readonly string[];
  readonly manifest: Awaited<ReturnType<EffectiveTree["content"]>>["manifest"];
  read(path: string): Promise<string | null>;
  page(href: string): ContentStructurePage | null;
}

/** The pages of one version, without its navigation files. */
export type ReviewPages = Pick<ReviewTree, "structure" | "page" | "read">;

/** A site with no version yet: every page of the other side is new. */
export const EMPTY_REVIEW_PAGES: ReviewPages = {
  structure: { pages: [], sections: [] },
  page: () => null,
  read: async () => null,
};

/** The source of the page at `href`, or null when the version has no such page. */
export async function readPageSource(
  tree: ReviewPages,
  href: string,
): Promise<string | null> {
  const page = tree.page(href);
  return page ? tree.read(page.sourcePath) : null;
}

/** A generated page body without the conflicts that a seeded writer lists. */
export function stripSeedConflicts(body: string | null): string | null {
  return body === null ? null : extractSeedConflicts(body).content;
}

/**
 * Reads one immutable version folder into a review tree. With the changes of
 * a branch based on that version, it reads the branch as it is now.
 */
export async function loadReviewTree(
  store: Pick<DocsContentStore, "read" | "listKeys">,
  artifactPrefix: string,
  changes: readonly EffectiveTreeChange[] = [],
): Promise<ReviewTree> {
  const tree = new EffectiveTree(store, artifactPrefix, changes);
  const content = await tree.content();
  const structure = contentStructureFromArtifacts(
    content.manifest,
    content.navigation.sectionsArtifact,
    content.navigation.documentsBySection,
  );
  const pages = new Map(
    structure.pages.map((page) => [normalizeHref(page.href), page]),
  );

  return {
    structure,
    sectionSlugs: [...content.navigation.documentsBySection.keys()],
    manifest: content.manifest,
    read: (path) => tree.read(path),
    page: (href) => pages.get(normalizeHref(href)) ?? null,
  };
}
