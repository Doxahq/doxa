import {
  parseSiteConfigLenient,
  resolveSiteConfig,
  upgradeV1SiteConfig,
  type ResolvedSiteConfig,
} from "@doxahq/site-config";

import type {
  DoxaDocsRuntimeSource,
  RuntimeRouteData,
} from "../runtime/runtime-source";
import { RuntimeSourceError } from "../runtime/runtime-source-error";

export async function loadSiteConfig(
  source: DoxaDocsRuntimeSource,
  route?: RuntimeRouteData
): Promise<ResolvedSiteConfig> {
  if (route && "siteConfig" in route && route.siteConfig)
    return parseSiteConfigLenient(route.siteConfig).config;
  if (source.getResolvedSiteConfig) {
    try {
      return parseSiteConfigLenient(await source.getResolvedSiteConfig())
        .config;
    } catch (error) {
      if (
        !(error instanceof RuntimeSourceError) ||
        !["invalid_request", "unknown_operation"].includes(error.code ?? "")
      )
        throw error;
    }
  }
  const [site, features] =
    route && (route.type === "page" || route.type === "not_found")
      ? [route.site, route.features]
      : await Promise.all([source.getSiteConfig(), source.getFeatureConfig()]);
  return resolveSiteConfig({
    ...upgradeV1SiteConfig({ projectName: site.name, features }),
    description: site.description ?? "",
  });
}
