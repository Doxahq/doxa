import type {
  ProjectAnalysis,
  ProjectReferenceSurfaces,
  SourceEvidence,
} from "../types";
import { normalizeProjectAnalysis } from "../utils/analysis-normalizer";

const PUBLIC_EVIDENCE_KINDS = new Set<SourceEvidence["kind"]>([
  "docs",
  "readme",
  "example",
]);

function hasPublicEvidence(evidence: SourceEvidence[]): boolean {
  return evidence.some((item) =>
    PUBLIC_EVIDENCE_KINDS.has(item.kind) ||
    /(^|\/)(readme|docs?|examples?|openapi|swagger)(\.|\/|$)/i.test(item.path)
  );
}

function isApiProduct(analysis: ProjectAnalysis): boolean {
  return analysis.projectCategory === "api" || analysis.projectProfile === "api";
}

function isSdkProduct(analysis: ProjectAnalysis): boolean {
  return analysis.projectCategory === "library" ||
    analysis.projectCategory === "framework" ||
    analysis.projectProfile === "library" ||
    analysis.projectProfile === "framework" ||
    (analysis.documentationIntent?.publicPackageNames.length ?? 0) > 0;
}

function filterRestSurface(
  analysis: ProjectAnalysis,
): ProjectReferenceSurfaces["rest"] | undefined {
  const surface = analysis.referenceSurfaces?.rest;
  if (!surface) return undefined;
  // A spec is the public contract: every endpoint it keeps is public.
  // `x-internal` and `x-hidden` already left out the others.
  if (surface.source?.kind === "openapi") return surface;
  const publicProduct = isApiProduct(analysis);
  const groups = surface.groups.flatMap((group) => {
    const groupIsPublic = publicProduct ||
      hasPublicEvidence(surface.sourceEvidence) ||
      hasPublicEvidence(group.sourceEvidence);
    const endpoints = group.endpoints.filter((endpoint) =>
      groupIsPublic || hasPublicEvidence(endpoint.sourceEvidence)
    );
    return endpoints.length > 0 ? [{ ...group, endpoints }] : [];
  });

  return groups.length > 0 ? { ...surface, groups } : undefined;
}

function filterSdkSurface(
  analysis: ProjectAnalysis,
): ProjectReferenceSurfaces["sdk"] | undefined {
  const surface = analysis.referenceSurfaces?.sdk;
  if (!surface) return undefined;
  const publicProduct = isSdkProduct(analysis);
  const modules = surface.modules.flatMap((module) => {
    const moduleIsPublic = publicProduct ||
      hasPublicEvidence(surface.sourceEvidence) ||
      hasPublicEvidence(module.sourceEvidence);
    const exports = module.exports.filter((entry) =>
      moduleIsPublic || hasPublicEvidence(entry.sourceEvidence)
    );
    return exports.length > 0 ? [{ ...module, exports }] : [];
  });

  return modules.length > 0 ? { ...surface, modules } : undefined;
}

/**
 * Keeps generated reference navigation limited to interfaces that are safe and
 * useful for public readers. Source-only implementation details do not become
 * public API docs unless public documentation or the product type exposes them.
 */
export function filterPublicReferenceSurfaces(input: ProjectAnalysis): ProjectAnalysis {
  const analysis = normalizeProjectAnalysis(input);
  const rest = filterRestSurface(analysis);
  const sdk = filterSdkSurface(analysis);

  return {
    ...analysis,
    referenceSurfaces: rest || sdk
      ? { ...(rest ? { rest } : {}), ...(sdk ? { sdk } : {}) }
      : undefined,
  };
}
