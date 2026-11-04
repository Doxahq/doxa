import type { DocsDomainResolution } from "@doxahq/contracts";
import { DocsRepository, type DocsRepositoryEnv } from "../repositories/docs";
import { DocsDomainsRepository } from "../repositories/docs-domains";
import { PreviewChannelsRepository } from "../repositories/preview-channels";
import {
  parseGeneratedDocsSubdomain,
  parseGenerationPreviewSubdomain,
} from "../utils/docs-url";

export type DocsResolutionEnv = Omit<DocsRepositoryEnv, "DOCS_CACHE_INVALIDATOR"> & {
  DOCS_BASE_DOMAIN?: string;
};

export async function resolveDocsHost(
  env: DocsResolutionEnv,
  hostname: string,
): Promise<DocsDomainResolution | null> {
  const generationPreview = parseGenerationPreviewSubdomain(
    hostname,
    env.DOCS_BASE_DOMAIN,
  );
  if (generationPreview) {
    const resolution = await new DocsRepository(env).resolveGenerationPreview(
      generationPreview,
    );
    return resolution
      ? { ...resolution, renderTarget: "generation_snapshot" }
      : null;
  }

  const explicitDomain = await new DocsDomainsRepository(env).resolveByHostname(
    hostname,
  );
  if (explicitDomain) {
    return { ...explicitDomain, renderTarget: "production" };
  }

  const preview = await new PreviewChannelsRepository(env).resolveByHostname(
    hostname,
  );
  if (preview) return { ...preview, renderTarget: "preview" };

  const generatedSubdomain = parseGeneratedDocsSubdomain(
    hostname,
    env.DOCS_BASE_DOMAIN,
  );
  if (!generatedSubdomain) return null;

  const site = await new DocsRepository(env).resolveBySlug(
    generatedSubdomain.projectSlug,
  );
  if (!site) return null;

  // A site with a working custom domain has one public address: its
  // `doxa.page` hostname only redirects there.
  const canonicalHostname = await new DocsDomainsRepository(
    env,
  ).findCanonicalHostname(site.siteId);
  return {
    ...site,
    hostname: generatedSubdomain.hostname,
    domainKind: "doxa_subdomain",
    renderTarget: "production",
    ...(canonicalHostname ? { canonicalHostname } : {}),
  };
}
