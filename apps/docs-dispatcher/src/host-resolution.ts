import type {
  DocsDomainResolution,
  DocsHostResolution,
} from "@doxahq/contracts";

/** Narrows a domain resolution to the fields that renderer RPCs may receive. */
export function toHostResolution(
  resolution: DocsDomainResolution,
): DocsHostResolution {
  return {
    siteId: resolution.siteId,
    projectId: resolution.projectId,
    projectSlug: resolution.projectSlug,
    publishedVersionId: resolution.publishedVersionId,
    artifactPrefix: resolution.artifactPrefix,
    manifestPath: resolution.manifestPath,
    accessPolicy: resolution.accessPolicy,
    // Canonical links of each hostname point to that hostname. Docs hosts
    // serve HTTPS only (M23).
    siteUrl: `https://${resolution.hostname}`,
  };
}
