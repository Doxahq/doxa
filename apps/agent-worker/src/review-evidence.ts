import type {
  GenerationPageState,
  IncrementalGenerationPlan,
} from "@doxahq/contracts";
import {
  MAX_SOURCE_PATHS,
  type PageSources,
} from "@doxahq/contracts/generation-reviews";
import { normalizeHref } from "@doxahq/docs-engine";

/**
 * The source files behind each page that the run wrote, for the review to
 * cite. Files that the writer read come first, then the evidence files.
 */
export function pageSourcesOf(
  plan: IncrementalGenerationPlan,
  pageStates: readonly GenerationPageState[],
): PageSources[] {
  const written = new Set(plan.regeneratePageIds);
  return pageStates.flatMap((page) => {
    if (!written.has(page.pageId)) return [];
    const paths = [
      ...new Set([
        ...page.dependencies.sourceFilesRead,
        ...page.dependencies.sourceEvidenceFiles,
      ]),
    ].slice(0, MAX_SOURCE_PATHS);
    return paths.length > 0
      ? [{ href: normalizeHref(page.route), paths }]
      : [];
  });
}

/**
 * The brief that each page was written with: this run's brief for a page that
 * the run wrote, and the earlier brief for a page that it reused. Pages
 * without a known brief get none.
 */
export function pageBriefFingerprints(input: {
  plan: IncrementalGenerationPlan;
  runBriefFingerprint: string | undefined;
  previousPages: readonly GenerationPageState[];
}): (pageId: string) => string | undefined {
  const written = new Set(input.plan.regeneratePageIds);
  const previous = new Map(
    input.previousPages.map((page) => [page.pageId, page.briefFingerprint]),
  );
  return (pageId) =>
    written.has(pageId) ? input.runBriefFingerprint : previous.get(pageId);
}
