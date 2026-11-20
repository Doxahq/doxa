import type { ImgHTMLAttributes } from "react"

import type { PictureFiles } from "~/lib/theme/picture-files"
import { THEMES, type Themed } from "~/lib/theme/theme"

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "sizes" | "loading">

interface ThemedPictureProps extends ImageProps {
  files: Themed<PictureFiles>
  sizes: string
}

/**
 * A photo with one copy for each theme. Each copy is its own <picture>, and CSS
 * hides the copy of the other theme (`[data-theme-only]` in globals.css). The theme
 * is known only in the browser, so the server sends both copies. Lazy loading makes
 * sure that the browser fetches only the copy on show: it does not fetch an image
 * that is not displayed. After a theme switch, the browser fetches the other copy once.
 *
 * For the same reason, a route must not preload a themed photo.
 */
export function ThemedPicture({ files, sizes, ...image }: ThemedPictureProps) {
  return THEMES.map((theme) => {
    const { avif, webp, fallback } = files[theme]
    return (
      <picture key={theme} data-theme-only={theme}>
        {avif ? <source type="image/avif" srcSet={avif} sizes={sizes} /> : null}
        <img loading="lazy" {...image} src={fallback} srcSet={webp} sizes={sizes} />
      </picture>
    )
  })
}
