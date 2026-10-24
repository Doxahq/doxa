import { sniffRasterImage, type RasterImageType } from "./image-type";
import { cleanSvg, type SvgProfile } from "./svg";

export type ImageContentType = RasterImageType | "image/svg+xml";

export interface ImageRules<T extends ImageContentType> {
  readonly maxBytes: number;
  /** The SVG allowlist that cleans an SVG upload. */
  readonly svgProfile: SvgProfile;
  /** The raster types this upload accepts; SVG is always accepted. */
  readonly accepts: (type: RasterImageType) => type is Extract<T, RasterImageType>;
}

export type CheckedImage<T extends ImageContentType> =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly contentType: T | "image/svg+xml";
      /** The SVG cleaning removed content, so the stored file differs. */
      readonly sanitized: boolean;
    }
  | { readonly ok: false; readonly reason: "too_large" | "unsupported_type" };

/**
 * The shared image upload check. It detects the type from the bytes, never
 * from the file name. A raster file is stored as sent. Any other file must be
 * UTF-8 SVG text; it is stored as the cleaned serialization of its
 * allowlisted tree, which must also fit the limit.
 */
export function checkImage<T extends ImageContentType>(
  bytes: Uint8Array,
  rules: ImageRules<T>,
): CheckedImage<T> {
  if (bytes.byteLength > rules.maxBytes) return { ok: false, reason: "too_large" };
  if (bytes.byteLength === 0) return { ok: false, reason: "unsupported_type" };

  const raster = sniffRasterImage(bytes);
  if (raster !== null) {
    return rules.accepts(raster)
      ? { ok: true, bytes, contentType: raster, sanitized: false }
      : { ok: false, reason: "unsupported_type" };
  }

  const cleaned = cleanSvgBytes(bytes, rules.svgProfile);
  if (cleaned === null) return { ok: false, reason: "unsupported_type" };
  if (cleaned.bytes.byteLength > rules.maxBytes) return { ok: false, reason: "too_large" };
  return {
    ok: true,
    bytes: cleaned.bytes,
    contentType: "image/svg+xml",
    sanitized: cleaned.removedCount > 0,
  };
}

/** Null when the bytes are not UTF-8 SVG. The decoder drops a leading BOM. */
function cleanSvgBytes(
  bytes: Uint8Array,
  profile: SvgProfile,
): { bytes: Uint8Array; removedCount: number } | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const cleaned = cleanSvg(text, profile);
    return { bytes: new TextEncoder().encode(cleaned.svg), removedCount: cleaned.removedCount };
  } catch {
    return null;
  }
}
