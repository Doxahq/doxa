import { relativeNavigationPathForSection } from "@doxahq/contracts/docs-branches";
import { extractSeedConflicts } from "@doxahq/contracts/generation-reviews";
import { sourcePathForHref } from "@doxahq/docs-engine";
import { toJsonArtifact } from "../docs-content/artifacts";
import { DocsContentError } from "../docs-content/errors";
import {
  applyStructureEdit,
  contentStructureToArtifacts,
  restoreStructurePage,
  setStructurePageTitle,
  type ContentStructure,
} from "../docs-content/structure";
import type { DesiredChange } from "../docs-branches/working-changes";
import {
  keepsGeneratedPage,
  keepsPublishedPage,
  type ReviewPageState,
} from "./review-pages";
import { SITE_CONFIG_PATH, type ReviewTree } from "./review-tree";

export interface ReviewChangeInput {
  main: ReviewTree;
  generated: ReviewTree;
  pages: readonly ReviewPageState[];
  /**
   * The navigation of the review branch. It defaults to the generated
   * navigation with every decision applied.
   */
  structure?: ContentStructure;
}

/**
 * The working files that make the review branch show the generated site
 * with every decision applied. The caller turns them into branch changes
 * against the published version.
 */
export async function desiredReviewChanges(
  input: ReviewChangeInput,
): Promise<Map<string, DesiredChange>> {
  const desired = new Map<string, DesiredChange>();

  // A page that a person moved keeps the body they moved with it.
  for (const page of input.pages.filter((entry) => entry.branchHref === null)) {
    const [path, body] = await desiredBody(page, input);
    desired.set(path, body);
  }

  const structure =
    input.structure ?? reviewStructure(input.main, input.generated, input.pages);
  for (const [path, content] of structureArtifactFiles(structure, input.main)) {
    desired.set(path, content);
  }

  // The site config comes from the published site, plus the runtime features
  // that the generation detected. Only a full build writes it, so a settings
  // edit on the review branch survives later decisions.
  const siteConfig = await input.generated.read(SITE_CONFIG_PATH);
  if (siteConfig !== null) {
    desired.set(SITE_CONFIG_PATH, siteConfig);
  }

  return desired;
}

/** The navigation that the review branch shows for these decisions. */
export function reviewStructure(
  main: ReviewTree,
  generated: ReviewTree,
  pages: readonly ReviewPageState[],
): ContentStructure {
  return pages.reduce((structure, page) => {
    if (page.change === "added" && page.decision === "rejected") {
      return applyStructureEdit(structure, {
        type: "delete_page",
        href: page.href,
      }).structure;
    }

    if (keepsPublishedPage(page)) {
      return restoreStructurePage(structure, main.structure, page.href);
    }

    const publishedTitle = main.page(page.href)?.title;
    if (
      page.change === "modified" &&
      page.decision === "rejected" &&
      publishedTitle !== undefined
    ) {
      return setStructurePageTitle(structure, page.href, publishedTitle);
    }

    return structure;
  }, generated.structure);
}

async function desiredBody(
  page: ReviewPageState,
  input: ReviewChangeInput,
): Promise<[path: string, body: DesiredChange]> {
  if (keepsGeneratedPage(page)) {
    const generatedPage = input.generated.page(page.href);
    const body = generatedPage
      ? await input.generated.read(generatedPage.sourcePath)
      : null;
    if (!generatedPage || body === null) {
      throw new DocsContentError(
        "invalid",
        `The generated page at ${page.href} could not be read.`,
      );
    }
    // The conflicts of a seeded writer belong in the review, not the page.
    return [generatedPage.sourcePath, extractSeedConflicts(body).content];
  }

  const publishedPage = input.main.page(page.href);
  if (!publishedPage) {
    return [sourcePathForHref(page.href), null];
  }

  const keepsPublishedBody =
    page.change !== "removed" || keepsPublishedPage(page);
  return [
    publishedPage.sourcePath,
    keepsPublishedBody ? await input.main.read(publishedPage.sourcePath) : null,
  ];
}

/**
 * The manifest and navigation files of a structure. A section that `tree`
 * has and the structure lost gets its navigation file removed.
 */
export function structureArtifactFiles(
  structure: ContentStructure,
  tree: Pick<ReviewTree, "manifest" | "sectionSlugs">,
): Array<[path: string, content: string | null]> {
  const artifacts = contentStructureToArtifacts(structure, tree.manifest);
  const files: Array<[string, string | null]> = [
    ["manifest.json", toJsonArtifact(artifacts.manifest)],
    ["settings/sections.json", toJsonArtifact(artifacts.sectionsArtifact)],
  ];

  for (const [slug, nodes] of artifacts.documentsBySection) {
    files.push([relativeNavigationPathForSection(slug), toJsonArtifact(nodes)]);
  }

  for (const slug of tree.sectionSlugs) {
    if (!artifacts.documentsBySection.has(slug)) {
      files.push([relativeNavigationPathForSection(slug), null]);
    }
  }

  return files;
}
