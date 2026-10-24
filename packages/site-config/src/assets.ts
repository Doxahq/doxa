import type { ResolvedSiteConfig } from "./schema/site-config";
import type { AssetRef } from "./primitives/asset-ref";

export function siteConfigAssetRefs(config: ResolvedSiteConfig): AssetRef[] {
  return [
    config.branding.logo.light,
    config.branding.logo.dark,
    config.branding.favicon,
    config.branding.ogImage,
  ].filter((ref): ref is AssetRef => ref !== null);
}

export function assetUrl(ref: AssetRef): string {
  return `/_doxa/assets/${ref.slice("asset:".length)}`;
}
