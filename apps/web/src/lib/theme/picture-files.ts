import type { Themed } from "~/lib/theme/theme"

/** The files of one responsive image, as `srcset` lists, under `public/`. */
export interface PictureFiles {
  /** Smaller AVIF files for browsers that read them. */
  avif?: string
  /** The WebP files, for browsers without AVIF. */
  webp: string
  /** One WebP file, for browsers without `srcset`. */
  fallback: string
}

/** The files `<base>-<width>.avif` and `<base>-<width>.webp`, one pair for each width. */
export function pictureFiles(base: string, widths: readonly number[], fallbackWidth: number): PictureFiles {
  const srcSet = (format: "avif" | "webp") => widths.map((width) => `${base}-${width}.${format} ${width}w`).join(", ")
  return { avif: srcSet("avif"), webp: srcSet("webp"), fallback: `${base}-${fallbackWidth}.webp` }
}

/**
 * The dark photo at `<base>-<width>` and its daylight copy at `<base>-light-<width>`,
 * in the same widths and formats.
 */
export function themedPictureFiles(base: string, widths: readonly number[], fallbackWidth: number): Themed<PictureFiles> {
  return {
    dark: pictureFiles(base, widths, fallbackWidth),
    light: pictureFiles(`${base}-light`, widths, fallbackWidth),
  }
}

/** The same files in both themes, for a photo that has no daylight copy. */
export function sameInBothThemes(files: PictureFiles): Themed<PictureFiles> {
  return { dark: files, light: files }
}
