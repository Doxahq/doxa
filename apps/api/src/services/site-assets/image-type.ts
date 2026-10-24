export type RasterImageType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/x-icon";

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * The raster type that the first bytes declare, whatever the file name says.
 * Null means no known raster signature; the caller can then try SVG text.
 */
export function sniffRasterImage(bytes: Uint8Array): RasterImageType | null {
  if (
    bytes.length >= 24 &&
    startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])
  )
    return "image/png";
  if (bytes.length >= 4 && startsWith(bytes, [255, 216, 255]))
    return "image/jpeg";
  if (
    bytes.length >= 16 &&
    startsWith(bytes, [82, 73, 70, 70]) &&
    startsWith(bytes, [87, 69, 66, 80], 8)
  )
    return "image/webp";
  // "GIF87a" or "GIF89a", then the logical screen descriptor.
  if (
    bytes.length >= 13 &&
    startsWith(bytes, [71, 73, 70, 56]) &&
    (bytes[4] === 55 || bytes[4] === 57) &&
    bytes[5] === 97
  )
    return "image/gif";
  if (
    bytes.length >= 22 &&
    startsWith(bytes, [0, 0, 1, 0]) &&
    (bytes[4] !== 0 || bytes[5] !== 0)
  )
    return "image/x-icon";
  return null;
}
