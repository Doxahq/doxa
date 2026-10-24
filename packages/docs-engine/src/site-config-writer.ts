import { canonicalJson } from "@doxahq/contracts/docs-prerender";
import {
  FREE_PLAN_ENTITLEMENTS,
  type ProjectEntitlements,
} from "@doxahq/contracts/entitlements";
import {
  createDefaultSiteConfig,
  enforceEntitlements,
  hashSiteConfig,
  resolveSiteConfig,
  type SiteConfigInput,
} from "@doxahq/site-config";

export interface SiteConfigArtifactInput {
  projectName: string;
  siteConfig?: SiteConfigInput;
  entitlements?: ProjectEntitlements;
  features?: { apiPlayground?: boolean };
}

/** One config writer for starter, container, and workflow publication. */
export async function createSiteConfigArtifact(input: SiteConfigArtifactInput) {
  const supplied = input.siteConfig ?? createDefaultSiteConfig(input);
  const requested = resolveSiteConfig({
    ...supplied,
    features: { ...input.features, ...supplied.features },
  });
  const config = resolveSiteConfig(
    enforceEntitlements(
      requested,
      input.entitlements ?? FREE_PLAN_ENTITLEMENTS,
    ),
  );
  if (config.branding.poweredBy !== requested.branding.poweredBy) {
    console.info(JSON.stringify({ event: "site_config_entitlement_applied" }));
  }
  const content = canonicalJson(config);
  return {
    manifestEntry: {
      path: "settings/site.json" as const,
      sha256: await hashSiteConfig(config),
    },
    file: {
      path: "settings/site.json",
      content,
      contentType: "application/json; charset=utf-8",
    },
  };
}
