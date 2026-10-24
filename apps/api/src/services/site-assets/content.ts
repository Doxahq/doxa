import {
  createValidationIssue,
  SITE_ASSET_MAX_BYTES,
  type SiteAssetContentType,
  type SiteAssetKind,
} from "@doxahq/site-config";
import { SiteConfigValidationError } from "../site-config-validation";
import { checkImage } from "./image-content";
import type { RasterImageType } from "./image-type";

type SiteRasterType = Exclude<SiteAssetContentType, "image/svg+xml">;

/** GIF is a docs image type only; a site asset never accepts it. */
function isSiteRaster(type: RasterImageType): type is SiteRasterType {
  return type !== "image/gif";
}

export function prepareSiteAsset(
  bytes: Uint8Array,
  kind: SiteAssetKind,
): {
  bytes: Uint8Array;
  contentType: SiteAssetContentType;
  sanitized: boolean;
} {
  const max = SITE_ASSET_MAX_BYTES[kind];
  const image = checkImage(bytes, { maxBytes: max, svgProfile: "site", accepts: isSiteRaster });
  if (image.ok) return { bytes: image.bytes, contentType: image.contentType, sanitized: image.sanitized };
  const issue =
    image.reason === "too_large"
      ? createValidationIssue("asset_too_large", "", { max })
      : createValidationIssue("asset_unsupported_type");
  throw new SiteConfigValidationError([issue]);
}
