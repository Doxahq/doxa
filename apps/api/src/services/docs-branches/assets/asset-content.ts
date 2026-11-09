import {
  DOCS_ASSET_EXTENSIONS,
  DOCS_ASSET_LIMITS,
  type DocsAssetContentType,
  type DocsAssetExtension,
} from "@doxahq/contracts/docs-assets";
import { DocsContentError } from "../../docs-content/errors";
import { compressUploadedImage, type ImageCompressor } from "../../site-assets/image-compression";
import {
  checkImage,
  checkImageIsolated,
  type CheckedImage,
  type ImageRules,
  type SvgCleaner,
} from "../../site-assets/image-content";
import { imageWorkerBusy } from "../../site-assets/upload-busy-errors";
import type { RasterImageType } from "../../site-assets/image-type";

export interface PreparedDocsAsset {
  bytes: Uint8Array;
  contentType: DocsAssetContentType;
  extension: DocsAssetExtension;
  /** The SVG cleaning removed content, so the stored file differs. */
  sanitized: boolean;
}

const MAX_MB = DOCS_ASSET_LIMITS.maxBytes / (1024 * 1024);

export function assetTooLarge(): DocsContentError {
  return new DocsContentError(
    "asset_too_large",
    `An image can have at most ${MAX_MB} MB.`,
    { maxBytes: DOCS_ASSET_LIMITS.maxBytes },
  );
}

function unsupportedType(): DocsContentError {
  return new DocsContentError(
    "asset_invalid",
    "The file is not a PNG, JPEG, WebP, GIF, or SVG image.",
  );
}

type DocsRasterType = Exclude<DocsAssetContentType, "image/svg+xml">;

/** A favicon is a site asset only; a docs image never is one. */
function isDocsRaster(type: RasterImageType): type is DocsRasterType {
  return type !== "image/x-icon";
}

export type DocsAssetCheck =
  | { readonly ok: true; readonly asset: PreparedDocsAsset }
  | { readonly ok: false; readonly reason: "too_large" | "unsupported_type" };

const DOCS_IMAGE_RULES: ImageRules<DocsAssetContentType> = {
  maxBytes: DOCS_ASSET_LIMITS.maxBytes,
  svgProfile: "docs_image",
  accepts: isDocsRaster,
};

function toPreparedAsset(
  image: Extract<CheckedImage<DocsAssetContentType>, { ok: true }>,
): PreparedDocsAsset {
  return {
    bytes: image.bytes,
    contentType: image.contentType,
    extension: DOCS_ASSET_EXTENSIONS[image.contentType],
    sanitized: image.sanitized,
  };
}

/**
 * Checks the image with the shared rules and the docs image SVG allowlist,
 * without throwing. The upload URL uses it to refuse a file that is not an
 * image before it stores anything.
 */
export function checkDocsAsset(bytes: Uint8Array): DocsAssetCheck {
  const image = checkImage(bytes, DOCS_IMAGE_RULES);
  return image.ok ? { ok: true, asset: toPreparedAsset(image) } : image;
}

function refusal(reason: "too_large" | "unsupported_type"): DocsContentError {
  return reason === "too_large" ? assetTooLarge() : unsupportedType();
}

/** `checkDocsAsset` for the upload paths that answer with an error. */
export function prepareDocsAsset(bytes: Uint8Array): PreparedDocsAsset {
  const checked = checkDocsAsset(bytes);
  if (checked.ok) return checked.asset;
  throw refusal(checked.reason);
}

/** `prepareDocsAsset`, with the SVG cleaning away from the API thread when the runtime can. */
export async function prepareDocsAssetIsolated(
  bytes: Uint8Array,
  cleaner: SvgCleaner | null | undefined,
): Promise<PreparedDocsAsset> {
  const image = await checkImageIsolated(bytes, DOCS_IMAGE_RULES, cleaner);
  if (image.ok) return toPreparedAsset(image);
  throw image.reason === "busy" ? imageWorkerBusy() : refusal(image.reason);
}

/** The asset to store: smaller when compression helps, else the same one. */
export async function compressDocsAsset(
  asset: PreparedDocsAsset,
  compressor: ImageCompressor | null | undefined,
): Promise<PreparedDocsAsset> {
  const compressed = await compressUploadedImage(compressor, asset, "docs_image");
  if (!compressed) return asset;
  return {
    ...asset,
    bytes: compressed.bytes,
    contentType: compressed.contentType,
    extension: DOCS_ASSET_EXTENSIONS[compressed.contentType],
  };
}

/**
 * Decodes standard base64. The size check runs on the encoded length first,
 * so an oversized upload is refused before it is decoded.
 */
export function decodeAssetBase64(input: string): Uint8Array {
  const compact = input.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  if ((compact.length / 4) * 3 - padding > DOCS_ASSET_LIMITS.maxBytes)
    throw assetTooLarge();
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new DocsContentError(
      "asset_invalid",
      "The file content is not valid base64.",
    );
  }
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
