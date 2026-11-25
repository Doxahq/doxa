import { isNeutral, parseColor, relativeLuminance, toHex } from "./color";

export type ImageFormat = "svg" | "png" | "jpeg" | "webp" | "gif" | "ico";

export interface InspectedImage {
  format: ImageFormat;
  width: number | null;
  height: number | null;
  /** SVG only: the most used colored paint, as #RRGGBB. */
  dominantColor: string | null;
  /** SVG only: every painted color is light, so it is drawn for dark backgrounds. */
  lightOnly: boolean;
}

export type ImageRejection =
  | "unknown_format"
  | "too_small"
  | "banner_shape"
  | "unpainted_svg";

const decoder = new TextDecoder();

function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && decoder.decode(b.subarray(0, 4)) === "RIFF" && decoder.decode(b.subarray(8, 12)) === "WEBP") return "webp";
  if (b.length >= 6 && decoder.decode(b.subarray(0, 3)) === "GIF") return "gif";
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "ico";
  const head = decoder.decode(b.subarray(0, Math.min(b.length, 1024))).trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

function rasterSize(format: ImageFormat, b: Uint8Array): [number, number] | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (format === "png" && b.length >= 24) return [view.getUint32(16), view.getUint32(20)];
    if (format === "gif" && b.length >= 10) return [view.getUint16(6, true), view.getUint16(8, true)];
    if (format === "webp" && b.length >= 30) {
      const chunk = decoder.decode(b.subarray(12, 16));
      if (chunk === "VP8X") return [1 + (view.getUint32(24, true) & 0xffffff), 1 + (view.getUint32(27, true) & 0xffffff)];
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
      }
      if (chunk === "VP8 ") return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    }
    if (format === "jpeg") {
      let offset = 2;
      while (offset + 9 < b.length) {
        if (b[offset] !== 0xff) return null;
        const marker = b[offset + 1];
        const length = view.getUint16(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function svgSize(svg: string): [number, number] | null {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const viewBox = root.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (viewBox) return [Number(viewBox[1]), Number(viewBox[2])];
  const width = root.match(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i);
  const height = root.match(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i);
  return width && height ? [Number(width[1]), Number(height[1])] : null;
}

const PAINT = /(?:fill|stroke|stop-color|color)\s*(?:=\s*["']|:\s*)\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|white|black)/gi;

function svgPaint(svg: string) {
  const colored = new Map<string, number>();
  let painted = 0;
  let light = 0;
  for (const match of svg.matchAll(PAINT)) {
    const rgb = parseColor(match[1]);
    if (!rgb) continue;
    painted += 1;
    if (relativeLuminance(rgb) > 0.8) light += 1;
    if (isNeutral(rgb)) continue;
    const hex = toHex(rgb);
    colored.set(hex, (colored.get(hex) ?? 0) + 1);
  }
  const dominant = [...colored.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { painted, lightOnly: painted > 0 && light === painted, dominant };
}

/**
 * An SVG with no paint of its own draws black by default, which is fine,
 * unless it turns paint off at the root and its shapes rely on the page CSS
 * that is not there any more.
 */
function isUnpaintedSvg(svg: string, painted: number): boolean {
  if (painted > 0 || /currentColor/i.test(svg)) return false;
  const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  return /\bfill\s*=\s*["']none["']/i.test(root);
}

/**
 * Reads the format, size and paint of a candidate logo or favicon. A logo
 * must not be a banner: the bake-off found README sponsor banners and hero
 * images among the candidates.
 */
export function inspectImage(
  bytes: Uint8Array,
  purpose: "logo" | "favicon",
): InspectedImage | { rejected: ImageRejection } {
  const format = sniffFormat(bytes);
  if (!format) return { rejected: "unknown_format" };
  if (format === "svg") {
    const svg = decoder.decode(bytes);
    const paint = svgPaint(svg);
    if (isUnpaintedSvg(svg, paint.painted)) return { rejected: "unpainted_svg" };
    const size = svgSize(svg);
    if (purpose === "logo" && size && !isLogoShape(size[0], size[1])) return { rejected: "banner_shape" };
    return {
      format,
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
      dominantColor: paint.dominant,
      lightOnly: paint.lightOnly,
    };
  }
  const size = format === "ico" ? null : rasterSize(format, bytes);
  if (purpose === "logo") {
    if (!size) return { rejected: "unknown_format" };
    if (Math.min(size[0], size[1]) < 16) return { rejected: "too_small" };
    if (!isLogoShape(size[0], size[1])) return { rejected: "banner_shape" };
  }
  return {
    format,
    width: size?.[0] ?? null,
    height: size?.[1] ?? null,
    dominantColor: null,
    lightOnly: false,
  };
}

/** Wordmarks are wide, icons are square; banners and hero images are neither. */
function isLogoShape(width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return true;
  const aspect = width / height;
  if (aspect > 8 || aspect < 0.33) return false;
  // A large, wide raster is a hero image or a banner, not a logo.
  return !(width >= 1200 && height >= 400);
}
