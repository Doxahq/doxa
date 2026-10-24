import { z } from "zod";
import {
  siteConfigSchema,
  type ResolvedSiteConfig,
} from "./schema/site-config";

export const clientSiteConfigSchema = siteConfigSchema.omit({ seo: true });
export type ClientSiteConfig = z.output<typeof clientSiteConfigSchema>;

export function toClientSiteConfig(
  config: ResolvedSiteConfig,
): ClientSiteConfig {
  const { seo: _seo, ...client } = config;
  return client;
}
