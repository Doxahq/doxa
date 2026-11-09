import sharp, { type Sharp, type SharpOptions } from "sharp";
import type {
  CompressedImage,
  ImageCompressionInput,
} from "../../../services/site-assets/image-compression";

/**
 * The encoder rule. The settings come from a measurement on UI screenshots,
 * diagrams, and photos: plain lossy WebP damages small colored text, and
 * palette PNG or `smartSubsample` keeps it readable.
 */

const INPUT_OPTIONS = {
  // A file can be tiny and declare a huge canvas. This refuses it before decoding.
  limitInputPixels: 40_000_000,
  failOn: "warning",
} satisfies SharpOptions;

/**
 * The pixel limit alone is not enough: decoder memory grows with the width,
 * so a 5 KB PNG of 39,000,000 x 1 pixels needed 2.4 GB. WebP has the same
 * width limit. A long page screenshot can be taller than it is wide.
 */
const MAX_INPUT_WIDTH = 16_383;
const MAX_INPUT_HEIGHT = 32_767;

/** Twice the article width covers sharp screens. */
const MAX_DOCS_IMAGE_WIDTH = 2400;

/** Below this saving, a new encode loses more quality than it is worth. */
const MAX_RESULT_SIZE_RATIO = 0.9;

interface Encoder {
  readonly contentType: CompressedImage["contentType"];
  encode(image: Sharp): Sharp;
}

const PALETTE_PNG: Encoder = {
  contentType: "image/png",
  encode: (image) => image.png({ palette: true, compressionLevel: 9 }),
};

const WEBP: Encoder = {
  contentType: "image/webp",
  encode: (image) => image.webp({ quality: 90, smartSubsample: true }),
};

const JPEG: Encoder = {
  contentType: "image/jpeg",
  encode: (image) => image.jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: "4:4:4" }),
};

/** Social crawlers do not all read WebP, so an OG image keeps its format. */
function encodersFor({ contentType, profile }: ImageCompressionInput): readonly Encoder[] {
  if (profile === "og_image") return contentType === "image/png" ? [PALETTE_PNG] : [JPEG];
  return contentType === "image/png" ? [PALETTE_PNG, WEBP] : [WEBP];
}

/** The smallest encode, or null when the original is the better file. */
export async function compressRaster(input: ImageCompressionInput): Promise<CompressedImage | null> {
  const { width, height, space, icc } = await sharp(input.bytes, INPUT_OPTIONS).metadata();
  if (width > MAX_INPUT_WIDTH || height > MAX_INPUT_HEIGHT) return null;
  // Without a color profile, CMYK values convert to the wrong colors.
  if (space === "cmyk" && !icc) return null;

  let smallest: CompressedImage | null = null;
  let lastError: unknown = null;
  for (const encoder of encodersFor(input)) {
    try {
      const bytes = await encoder.encode(prepare(input)).toBuffer();
      if (!smallest || bytes.byteLength < smallest.bytes.byteLength) {
        smallest = { bytes, contentType: encoder.contentType };
      }
    } catch (cause) {
      // One encoder can refuse an image that another accepts: WebP has a
      // maximum height of 16383 pixels.
      lastError = cause;
    }
  }

  if (!smallest) throw lastError;
  return smallest.bytes.byteLength <= input.bytes.byteLength * MAX_RESULT_SIZE_RATIO ? smallest : null;
}

/** `rotate()` applies the EXIF orientation. The output has no metadata, so GPS data goes too. */
function prepare(input: ImageCompressionInput): Sharp {
  const image = sharp(input.bytes, INPUT_OPTIONS).rotate();
  return input.profile === "docs_image"
    ? image.resize({ width: MAX_DOCS_IMAGE_WIDTH, withoutEnlargement: true })
    : image;
}
