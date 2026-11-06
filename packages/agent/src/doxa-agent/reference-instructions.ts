import type {
  DocumentationGenerationBrief,
  DocumentationStructure,
  ProjectAnalysis,
  RestApiReferenceSurface,
  SdkApiReferenceSurface,
  SourceEvidence,
} from "../types";
import { compilePathGlob, normalizePath } from "../utils/path-glob";

/**
 * The project owner's Doxabot instructions decide what the API reference
 * documents. The kind of project that the model sees does not, and neither
 * does whether an endpoint looks internal. Code applies the instructions, so
 * the result does not depend on a model following them:
 *
 * - With the "API reference" page type off, the analysis keeps no reference
 *   surface and a new plan keeps no reference page.
 * - An endpoint or export whose source evidence is only under a "Do not
 *   document" path is left out.
 *
 * Every other endpoint and export that the analysis found stays.
 */

type ReferenceBrief = Pick<DocumentationGenerationBrief, "projectInstructions">;

export type PathMatcher = (path: string) => boolean;

/** Without saved instructions, the defaults apply: the API reference is on. */
export function isReferenceEnabled(brief: ReferenceBrief | undefined): boolean {
  return brief?.projectInstructions?.instructions.pageTypes.includes("reference") ?? true;
}

/** The analysis with the reference surfaces that the instructions keep. */
export function applyReferenceInstructions(
  analysis: ProjectAnalysis,
  brief: ReferenceBrief | undefined,
): ProjectAnalysis {
  const surfaces = analysis.referenceSurfaces;
  if (!surfaces) return analysis;
  if (!isReferenceEnabled(brief)) return { ...analysis, referenceSurfaces: undefined };

  const isExcluded = excludedPathMatcher(brief?.projectInstructions?.instructions.doNotDocument ?? []);
  if (!isExcluded) return analysis;

  const rest = surfaces.rest && restSurfaceWithout(surfaces.rest, isExcluded);
  const sdk = surfaces.sdk && sdkSurfaceWithout(surfaces.sdk, isExcluded);
  return {
    ...analysis,
    referenceSurfaces: rest || sdk
      ? { ...(rest ? { rest } : {}), ...(sdk ? { sdk } : {}) }
      : undefined,
  };
}

/**
 * A new plan without reference pages when the API reference is off. The
 * planner can echo them from the published structure, so code removes them,
 * with the sections that they leave empty.
 */
export function applyReferenceInstructionsToStructure(
  structure: DocumentationStructure,
  brief: ReferenceBrief | undefined,
): DocumentationStructure {
  if (isReferenceEnabled(brief)) return structure;
  return {
    sections: structure.sections.flatMap((section) => {
      const pages = section.pages.filter((page) => !page.reference);
      return pages.length > 0 ? [{ ...section, pages }] : [];
    }),
  };
}

/**
 * An item goes when its nearest evidence is all excluded. The items that stay
 * then lose the excluded paths at every level, so no later step reads them:
 * the decision reads the evidence before it changes.
 */
function restSurfaceWithout(
  surface: RestApiReferenceSurface,
  isExcluded: PathMatcher,
): RestApiReferenceSurface | undefined {
  const groups = surface.groups.flatMap((group) => {
    const endpoints = group.endpoints
      .filter((endpoint) =>
        !isOnlyUnder(isExcluded, endpoint.sourceEvidence, group.sourceEvidence, surface.sourceEvidence)
      )
      .map((endpoint) => withKeptEvidence(endpoint, isExcluded));
    return endpoints.length > 0 ? [{ ...withKeptEvidence(group, isExcluded), endpoints }] : [];
  });
  return groups.length > 0 ? { ...withKeptEvidence(surface, isExcluded), groups } : undefined;
}

function sdkSurfaceWithout(
  surface: SdkApiReferenceSurface,
  isExcluded: PathMatcher,
): SdkApiReferenceSurface | undefined {
  const modules = surface.modules.flatMap((module) => {
    const exports = module.exports
      .filter((entry) =>
        !isOnlyUnder(isExcluded, entry.sourceEvidence, module.sourceEvidence, surface.sourceEvidence)
      )
      .map((entry) => withKeptEvidence(entry, isExcluded));
    return exports.length > 0 ? [{ ...withKeptEvidence(module, isExcluded), exports }] : [];
  });
  return modules.length > 0 ? { ...withKeptEvidence(surface, isExcluded), modules } : undefined;
}

/** The value without the evidence under a "Do not document" path. */
export function withKeptEvidence<T extends { sourceEvidence: SourceEvidence[] }>(
  value: T,
  isExcluded: PathMatcher,
): T {
  const kept = value.sourceEvidence.filter((item) => !isExcluded(item.path));
  return kept.length === value.sourceEvidence.length ? value : { ...value, sourceEvidence: kept };
}

/**
 * Whether every path of the nearest evidence is excluded. An item without
 * evidence of its own takes the evidence of its group or module, then of
 * the surface. An item without any evidence stays.
 */
export function isOnlyUnder(isExcluded: PathMatcher, ...evidenceLevels: SourceEvidence[][]): boolean {
  const evidence = evidenceLevels.find((level) => level.length > 0);
  return evidence !== undefined && evidence.every((item) => isExcluded(item.path));
}

/** A path is excluded when a glob matches the path or one of its folders. */
export function excludedPathMatcher(globs: readonly string[]): PathMatcher | undefined {
  if (globs.length === 0) return undefined;
  const matchers = globs.flatMap(compileExcludedGlob);
  if (matchers.length === 0) return undefined;
  return (path) => pathAndFolders(normalizePath(path)).some((candidate) =>
    matchers.some((matches) => matches(candidate))
  );
}

/** `a/b/c.ts` gives `a`, `a/b` and `a/b/c.ts`. */
/**
 * The matcher of one owner glob, or none when it cannot compile. The schema
 * refuses such a glob, so only instructions saved before a schema rule reach
 * here: one bad glob must not stop every run.
 */
function compileExcludedGlob(glob: string): PathMatcher[] {
  try {
    return [compilePathGlob(glob.replace(/\/+$/, ""))];
  } catch (error) {
    console.warn(`Doxabot skipped the "Do not document" path ${JSON.stringify(glob)}: ${errorMessage(error)}`);
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathAndFolders(path: string): string[] {
  const segments = path.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}
