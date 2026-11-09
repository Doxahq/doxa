import {
  createValidationIssue,
  SITE_ASSET_MAX_BYTES,
  type SiteAssetContentType,
  type SiteAssetKind,
} from "@doxahq/site-config";
import { SiteConfigValidationError } from "../site-config-validation";
import {
  checkImage,
  checkImageIsolated,
  type CheckedImage,
  type ImageRules,
  type SvgCleaner,
} from "./image-content";
import { imageWorkerBusy } from "./upload-busy-errors";
import type { RasterImageType } from "./image-type";

type SiteRasterType = Exclude<SiteAssetContentType, "image/svg+xml">;

/** GIF is a docs image type only; a site asset never accepts it. */
function isSiteRaster(type: RasterImageType): type is SiteRasterType {
  return type !== "image/gif";
}

export interface PreparedSiteAsset {
  bytes: Uint8Array;
  contentType: SiteAssetContentType;
  sanitized: boolean;
}

function rulesFor(kind: SiteAssetKind): ImageRules<SiteAssetContentType> {
  return { maxBytes: SITE_ASSET_MAX_BYTES[kind], svgProfile: "site", accepts: isSiteRaster };
}

function preparedOrThrow(
  image: CheckedImage<SiteAssetContentType>,
  kind: SiteAssetKind,
): PreparedSiteAsset {
  if (image.ok) return { bytes: image.bytes, contentType: image.contentType, sanitized: image.sanitized };
  const issue =
    image.reason === "too_large"
      ? createValidationIssue("asset_too_large", "", { max: SITE_ASSET_MAX_BYTES[kind] })
      : createValidationIssue("asset_unsupported_type");
  throw new SiteConfigValidationError([issue]);
}

export function prepareSiteAsset(bytes: Uint8Array, kind: SiteAssetKind): PreparedSiteAsset {
  return preparedOrThrow(checkImage(bytes, rulesFor(kind)), kind);
}

/** `prepareSiteAsset`, with the SVG cleaning away from the API thread when the runtime can. */
export async function prepareSiteAssetIsolated(
  bytes: Uint8Array,
  kind: SiteAssetKind,
  cleaner: SvgCleaner | null | undefined,
): Promise<PreparedSiteAsset> {
  const image = await checkImageIsolated(bytes, rulesFor(kind), cleaner);
  if (!image.ok && image.reason === "busy") throw imageWorkerBusy();
  return preparedOrThrow(image, kind);
}
