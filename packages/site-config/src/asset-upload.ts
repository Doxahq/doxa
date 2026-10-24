import { z } from "zod";

export const siteAssetKindSchema = z.enum(["logo", "favicon", "ogImage"]);
export type SiteAssetKind = z.infer<typeof siteAssetKindSchema>;

export const SITE_ASSET_MAX_BYTES = {
  logo: 512 * 1024,
  favicon: 128 * 1024,
  ogImage: 2 * 1024 * 1024,
} as const satisfies Record<SiteAssetKind, number>;

export const siteAssetContentTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/x-icon",
  "image/svg+xml",
]);
export type SiteAssetContentType = z.infer<typeof siteAssetContentTypeSchema>;
