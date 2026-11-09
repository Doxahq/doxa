import { z } from "zod";
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

/** `busy`: the isolated cleaner gave no result, and the file was not stored. */
export type IsolatedImageCheck<T extends ImageContentType> =
  | CheckedImage<T>
  | { readonly ok: false; readonly reason: "busy" };

const uint8ArraySchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array);

export const svgCleaningInputSchema = z
  .object({ bytes: uint8ArraySchema, profile: z.enum(["site", "docs_image"]) })
  .strict();
export type SvgCleaningInput = z.infer<typeof svgCleaningInputSchema>;

export const cleanedSvgBytesSchema = z
  .object({ bytes: uint8ArraySchema, removedCount: z.number().int().nonnegative() })
  .strict();
export type CleanedSvgBytes = z.infer<typeof cleanedSvgBytesSchema>;

/**
 * Runs the SVG cleaning away from the thread that calls it. Only the Node
 * origin has one: a parse there would stop every other request of the API.
 */
export interface SvgCleaner {
  /** Null when the bytes are not valid SVG. Rejects when no result exists. */
  clean(input: SvgCleaningInput): Promise<CleanedSvgBytes | null>;
}

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
  return checkRaster(bytes, rules) ?? checkedSvg(cleanSvgBytes(bytes, rules.svgProfile), rules);
}

/** `checkImage`, with the SVG cleaning in `cleaner` when the runtime has one. */
export async function checkImageIsolated<T extends ImageContentType>(
  bytes: Uint8Array,
  rules: ImageRules<T>,
  cleaner: SvgCleaner | null | undefined,
): Promise<IsolatedImageCheck<T>> {
  if (!cleaner) return checkImage(bytes, rules);
  const raster = checkRaster(bytes, rules);
  if (raster) return raster;
  try {
    return checkedSvg(await cleaner.clean({ bytes, profile: rules.svgProfile }), rules);
  } catch (cause) {
    console.warn("SVG cleaning failed. The file was not stored.", cause);
    return { ok: false, reason: "busy" };
  }
}

/** The result for anything but an SVG file. Null means: treat it as SVG. */
function checkRaster<T extends ImageContentType>(
  bytes: Uint8Array,
  rules: ImageRules<T>,
): CheckedImage<T> | null {
  if (bytes.byteLength > rules.maxBytes) return { ok: false, reason: "too_large" };
  if (bytes.byteLength === 0) return { ok: false, reason: "unsupported_type" };

  const raster = sniffRasterImage(bytes);
  if (raster === null) return null;
  return rules.accepts(raster)
    ? { ok: true, bytes, contentType: raster, sanitized: false }
    : { ok: false, reason: "unsupported_type" };
}

function checkedSvg<T extends ImageContentType>(
  cleaned: CleanedSvgBytes | null,
  rules: ImageRules<T>,
): CheckedImage<T> {
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
export function cleanSvgBytes(bytes: Uint8Array, profile: SvgProfile): CleanedSvgBytes | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const cleaned = cleanSvg(text, profile);
    return { bytes: new TextEncoder().encode(cleaned.svg), removedCount: cleaned.removedCount };
  } catch {
    return null;
  }
}
