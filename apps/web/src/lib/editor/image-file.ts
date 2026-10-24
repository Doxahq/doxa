import { DOCS_ASSET_LIMITS } from "@doxahq/contracts/docs-assets"

/** The image types a page can hold. The server checks the bytes again. */
export const IMAGE_UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml"

const ACCEPTED_TYPES = new Set(IMAGE_UPLOAD_ACCEPT.split(","))

/** Wider images are scaled down: twice the article width covers sharp screens. */
export const MAX_IMAGE_WIDTH = 2400

/** Raster images below this size and width are sent as they are. */
const SMALL_IMAGE_BYTES = 300 * 1024

const WEBP_QUALITY = 0.86

/** The image files among dropped or pasted files. */
export function imageFiles(files: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  return files ? Array.from(files).filter((file) => ACCEPTED_TYPES.has(file.type)) : []
}

/**
 * The file to upload for a picked, pasted or dropped image.
 *
 * Screenshots arrive as large PNGs. A PNG, JPEG or WebP image that is wide
 * or heavy is scaled to `MAX_IMAGE_WIDTH` and stored as WebP, which is often
 * five to ten times smaller. The original is kept when the result is not
 * smaller. GIF (it can be animated) and SVG files are sent as they are.
 */
export async function prepareImageUpload(file: File): Promise<File> {
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }

  try {
    if (file.size <= SMALL_IMAGE_BYTES && bitmap.width <= MAX_IMAGE_WIDTH) return file
    const scale = Math.min(1, MAX_IMAGE_WIDTH / bitmap.width)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext("2d")
    if (!context) return file
    context.drawImage(bitmap, 0, 0, width, height)
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY })
    // A browser without a WebP encoder returns PNG instead.
    if (blob.type !== "image/webp" || blob.size >= file.size) return file
    return new File([blob], replaceExtension(file.name, "webp"), { type: "image/webp" })
  } catch {
    return file
  } finally {
    bitmap.close()
  }
}

/** The message for a file the server would refuse for its size, or null. */
export function imageTooLargeMessage(file: File): string | null {
  return file.size > DOCS_ASSET_LIMITS.maxBytes
    ? `${file.name || "This image"} is larger than ${DOCS_ASSET_LIMITS.maxBytes / (1024 * 1024)} MB.`
    : null
}

/**
 * Alt text from a file name: `rate-limits_diagram.png` reads "rate limits
 * diagram". A pasted image (`image.png`) or a screenshot name says nothing
 * about the picture, so it gives no alt text.
 */
export function altTextFromFileName(name: string): string {
  const text = name
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return /^(image|img|screenshot|screen shot|pasted|clipboard)\b/i.test(text) ? "" : text
}

function replaceExtension(name: string, extension: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "image"
  return `${base}.${extension}`
}
