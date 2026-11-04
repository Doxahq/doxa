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

type PathMatcher = (path: string) => boolean;

/** Without saved instructions, the defaults apply: the API reference is on. */
function isReferenceEnabled(brief: ReferenceBrief | undefined): boolean {
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

function restSurfaceWithout(
  surface: RestApiReferenceSurface,
  isExcluded: PathMatcher,
): RestApiReferenceSurface | undefined {
  const groups = surface.groups.flatMap((group) => {
    const endpoints = group.endpoints.filter((endpoint) =>
      !isOnlyUnder(isExcluded, endpoint.sourceEvidence, group.sourceEvidence, surface.sourceEvidence)
    );
    return endpoints.length > 0 ? [{ ...group, endpoints }] : [];
  });
  return groups.length > 0 ? { ...surface, groups } : undefined;
}

function sdkSurfaceWithout(
  surface: SdkApiReferenceSurface,
  isExcluded: PathMatcher,
): SdkApiReferenceSurface | undefined {
  const modules = surface.modules.flatMap((module) => {
    const exports = module.exports.filter((entry) =>
      !isOnlyUnder(isExcluded, entry.sourceEvidence, module.sourceEvidence, surface.sourceEvidence)
    );
    return exports.length > 0 ? [{ ...module, exports }] : [];
  });
  return modules.length > 0 ? { ...surface, modules } : undefined;
}

/**
 * Whether every path of the nearest evidence is excluded. An item without
 * evidence of its own takes the evidence of its group or module, then of
 * the surface. An item without any evidence stays.
 */
function isOnlyUnder(isExcluded: PathMatcher, ...evidenceLevels: SourceEvidence[][]): boolean {
  const evidence = evidenceLevels.find((level) => level.length > 0);
  return evidence !== undefined && evidence.every((item) => isExcluded(item.path));
}

/** A path is excluded when a glob matches the path or one of its folders. */
function excludedPathMatcher(globs: readonly string[]): PathMatcher | undefined {
  if (globs.length === 0) return undefined;
  const matchers = globs.map((glob) => compilePathGlob(glob.replace(/\/+$/, "")));
  return (path) => pathAndFolders(normalizePath(path)).some((candidate) =>
    matchers.some((matches) => matches(candidate))
  );
}

/** `a/b/c.ts` gives `a`, `a/b` and `a/b/c.ts`. */
function pathAndFolders(path: string): string[] {
  const segments = path.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}
