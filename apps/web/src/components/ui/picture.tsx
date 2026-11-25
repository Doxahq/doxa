import type { ImgHTMLAttributes } from "react"

import type { PictureFiles } from "~/lib/theme/picture-files"
import type { Theme } from "~/lib/theme/theme"

export type PictureImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "sizes">

interface PictureProps extends PictureImageProps {
  files: PictureFiles
  sizes: string
  /** Shows the picture only in this theme (`[data-theme-only]` in globals.css). */
  theme?: Theme
}

/**
 * One responsive photo: AVIF for the browsers that read it, WebP for the others.
 * The image props come before `src`, so a lazy image is lazy before it starts to load.
 */
export function Picture({ files, sizes, theme, ...image }: PictureProps) {
  return (
    <picture data-theme-only={theme}>
      {files.avif ? <source type="image/avif" srcSet={files.avif} sizes={sizes} /> : null}
      <img {...image} src={files.fallback} srcSet={files.webp} sizes={sizes} />
    </picture>
  )
}
