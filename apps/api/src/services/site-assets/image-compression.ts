import { DOCS_ASSET_LIMITS } from "@doxahq/contracts/docs-assets";
import { z } from "zod";
import { sniffRasterImage } from "./image-type";

/**
 * Compression of uploaded raster images, as the upload paths see it. This
 * module is runtime-neutral: the encoder runs only on the Node origin, behind
 * the `ImageCompressor` interface. The `doxa-mcp` Worker reaches it over RPC.
 *
 * Compression is an optimization. When it fails, times out, or saves too
 * little, the upload stores the original file, as it did before.
 */

export const imageCompressionProfileSchema = z.enum(["docs_image", "logo", "og_image"]);
export type ImageCompressionProfile = z.infer<typeof imageCompressionProfileSchema>;

const uint8ArraySchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array);

const compressibleImageTypeSchema = z.enum(["image/png", "image/jpeg"]);

export const imageCompressionInputSchema = z
  .object({
    bytes: uint8ArraySchema.refine((bytes) => bytes.byteLength <= DOCS_ASSET_LIMITS.maxBytes),
    contentType: compressibleImageTypeSchema,
    profile: imageCompressionProfileSchema,
  })
  .strict();
export type ImageCompressionInput = z.infer<typeof imageCompressionInputSchema>;

export const compressedImageSchema = z
  .object({
    bytes: uint8ArraySchema,
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  })
  .strict();
export type CompressedImage = z.infer<typeof compressedImageSchema>;

export interface ImageCompressor {
  /** Null when the original file is the better one to store. */
  compress(input: ImageCompressionInput): Promise<CompressedImage | null>;
}

/**
 * Compresses a checked upload. Null means: store the original. This never
 * throws, because a compression problem must not fail an upload.
 *
 * WebP, GIF, ICO, and SVG files are left alone: a WebP file is usually
 * compressed already, and a second lossy encode only loses quality. An
 * animated PNG is left alone because an encoder keeps only its first frame.
 */
export async function compressUploadedImage(
  compressor: ImageCompressor | null | undefined,
  image: { readonly bytes: Uint8Array; readonly contentType: string },
  profile: ImageCompressionProfile,
): Promise<CompressedImage | null> {
  if (!compressor) return null;
  const contentType = compressibleImageTypeSchema.safeParse(image.contentType);
  if (!contentType.success) return null;
  if (contentType.data === "image/png" && isAnimatedPng(image.bytes)) return null;

  try {
    // The result crosses a process and, for MCP, an RPC call: check its shape.
    const result: unknown = await compressor.compress({
      bytes: image.bytes,
      contentType: contentType.data,
      profile,
    });
    const parsed = compressedImageSchema.safeParse(result);
    return parsed.success && isUsableResult(parsed.data, image.bytes) ? parsed.data : null;
  } catch (cause) {
    console.warn("Image compression failed. The original file is stored.", cause);
    return null;
  }
}

/** The stored name and Content-Type follow this type, so it must be true. */
function isUsableResult(result: CompressedImage, original: Uint8Array): boolean {
  return (
    result.bytes.byteLength < original.byteLength &&
    sniffRasterImage(result.bytes) === result.contentType
  );
}

const PNG_SIGNATURE_LENGTH = 8;
/** The length and type fields before a PNG chunk's data, and the CRC after it. */
const PNG_CHUNK_HEADER_LENGTH = 8;
const PNG_CHUNK_CRC_LENGTH = 4;

/** An animated PNG declares `acTL` before its first `IDAT` chunk. */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE_LENGTH;
  while (offset + PNG_CHUNK_HEADER_LENGTH <= bytes.byteLength) {
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    offset += PNG_CHUNK_HEADER_LENGTH + view.getUint32(offset) + PNG_CHUNK_CRC_LENGTH;
  }
  return false;
}
