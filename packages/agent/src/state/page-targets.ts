import type { DocPage, DocumentationStructure } from "../types";
import type { PageDependencyState, PageTarget } from "./types";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pageSlug(page: DocPage): string {
  return slugify(page.id || page.title);
}

export function flattenStructure(structure: DocumentationStructure): PageTarget[] {
  const targets: PageTarget[] = [];

  for (const section of structure.sections) {
    const sectionSlug = section.default ? "default" : slugify(section.id || section.title);

    for (const page of section.pages) {
      const basePageId = page.id;
      const baseSlug = pageSlug(page);
      const baseOutputPath = `${sectionSlug}/${baseSlug}/index.mdx`;

      targets.push({
        pageId: basePageId,
        title: page.title,
        sectionTitle: section.title,
        outputPath: baseOutputPath,
        description: page.description,
        sourceEvidence: page.sourceEvidence ?? [],
        collectionId: page.collectionId,
        collectionItemId: page.collectionItemId,
        canonicalRoute: page.canonicalRoute,
        reference: page.reference,
      });

    }
  }

  return targets;
}

/** Source files a page author actually used, beyond the declared evidence. */
export interface RecordedPageSources {
  sourceFilesRead?: readonly string[];
  sourceFilesDiscovered?: readonly string[];
  evidenceBundlePaths?: readonly string[];
}

export function createPageDependencyState(
  target: Pick<
    PageTarget,
    "sourceEvidence" | "canonicalRoute" | "reference"
  >,
  recorded: RecordedPageSources = {},
): PageDependencyState {
  return {
    sourceFilesRead: normalizeSourcePaths([
      ...(recorded.sourceFilesRead ?? []),
      ...(recorded.evidenceBundlePaths ?? []),
    ]),
    sourceFilesDiscovered: normalizeSourcePaths(
      recorded.sourceFilesDiscovered ?? [],
    ),
    sourceEvidenceFiles: normalizeSourcePaths(
      target.sourceEvidence.map((evidence) => evidence.path),
    ),
    referencedSymbols: sortedUnique([
      target.reference?.exportName,
    ]),
    referencedRoutes: sortedUnique([
      target.canonicalRoute,
      target.reference?.kind === "rest"
        ? target.reference.path
        : undefined,
    ]),
  };
}

export function emptyPageDependencyState(): PageDependencyState {
  return {
    sourceFilesRead: [],
    sourceFilesDiscovered: [],
    sourceEvidenceFiles: [],
    referencedSymbols: [],
    referencedRoutes: [],
  };
}

function normalizeSourcePaths(paths: readonly string[]): string[] {
  return sortedUnique(
    paths.map(normalizeSourcePath).filter(
      (path): path is string => path !== null,
    ),
  );
}

function normalizeSourcePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\0")
  ) {
    return null;
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function sortedUnique(
  values: readonly (string | undefined)[],
): string[] {
  return [...new Set(
    values.filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    ),
  )].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
