import { canonicalJson } from "@doxahq/contracts/docs-prerender";
import {
  DOCS_ARTIFACT_SCHEMA_VERSION,
  type DocsManifest,
} from "@doxahq/docs-engine";
import { hashSiteConfig, type ResolvedSiteConfig } from "@doxahq/site-config";

/** Upgrade the config before stamping the manifest, never just its version. */
export async function upgradeArtifactToCurrentSchema(
  baseManifest: DocsManifest,
  config: ResolvedSiteConfig,
  targetVersion: 1 | 2 = DOCS_ARTIFACT_SCHEMA_VERSION,
): Promise<{ manifest: DocsManifest; siteConfigJson: string | null }> {
  if (targetVersion === 1 && baseManifest.schemaVersion === 1) {
    return { manifest: baseManifest, siteConfigJson: null };
  }
  const siteConfigJson = canonicalJson(config);
  return {
    manifest: {
      ...baseManifest,
      schemaVersion: 2,
      siteConfig: {
        path: "settings/site.json",
        sha256: await hashSiteConfig(config),
      },
    },
    siteConfigJson,
  };
}
