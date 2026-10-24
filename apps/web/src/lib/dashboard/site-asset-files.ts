import {
  createValidationIssue,
  SITE_ASSET_MAX_BYTES,
  type SiteAssetKind,
  type ValidationIssue,
} from "@doxahq/site-config"

/** File extensions the upload input offers. The server checks the bytes. */
export const SITE_ASSET_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".ico", ".svg"] as const

export const SITE_ASSET_ACCEPT = SITE_ASSET_EXTENSIONS.join(",")

/**
 * A fast check before an upload, for feedback without a request.
 *
 * It reads only the name and the size. The server is the authority: it reads
 * the magic bytes and sanitizes SVG files.
 */
export function checkSiteAssetFile(
  kind: SiteAssetKind,
  file: Pick<File, "name" | "size">,
): ValidationIssue | null {
  const name = file.name.toLowerCase()
  if (!SITE_ASSET_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return createValidationIssue("asset_unsupported_type")
  }
  const max = SITE_ASSET_MAX_BYTES[kind]
  if (file.size > max) return createValidationIssue("asset_too_large", "", { max })
  return null
}

export function formatByteLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`
}

/** The file types and the size limit for one asset kind, as a sentence. */
export function describeSiteAssetFiles(kind: SiteAssetKind): string {
  return `PNG, JPEG, WebP, ICO, or SVG, up to ${formatByteLimit(SITE_ASSET_MAX_BYTES[kind])}.`
}
