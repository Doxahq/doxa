import {
  siteConfigSchema,
  type SiteConfigInput,
  type ResolvedSiteConfig,
} from "./schema/site-config";
import { defaultSiteName } from "./primitives/site-name";

export function resolveSiteConfig(input: SiteConfigInput): ResolvedSiteConfig {
  return siteConfigSchema.parse(input);
}

export function createDefaultSiteConfig(project: {
  projectName: string;
}): SiteConfigInput {
  return { name: defaultSiteName(project.projectName) };
}
