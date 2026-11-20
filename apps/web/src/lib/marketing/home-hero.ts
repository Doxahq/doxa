import { type PictureFiles, pictureFiles, sameInBothThemes, themedPictureFiles } from "~/lib/theme/picture-files"
import type { Themed } from "~/lib/theme/theme"

/**
 * Which hero the landing page shows.
 *
 * - "v1": the left-aligned copy with the aurora and the robotic hands that solve a cube
 *   (`home-hero.tsx`).
 * - "v2": the centered copy with the docs window rising out of the night dunes
 *   (`home-hero-v2.tsx`).
 *
 * Both stay in the code, so a swap is this one line.
 */
export type HomeHeroVersion = "v1" | "v2"

export const HOME_HERO_VERSION: HomeHeroVersion = "v2"

/** One hero photo, with a copy for each theme, each as AVIF with a WebP fallback. */
export interface HeroImage {
  files: Themed<PictureFiles>
  /** The intrinsic size of the largest file, for the layout before it loads. */
  width: number
  height: number
}

/** 960 to 3072 come from the photo as generated (3072px wide). 4096 comes from a 2x Topaz
 * upscale (High Fidelity V2, blended 70/30 with a smooth enlargement to keep the grain soft),
 * so large retina screens get a sharp photo. */
const DUNE_WIDTHS = [960, 1440, 2160, 3072, 4096] as const
const DOCS_WIDTHS = [720, 1040, 2080] as const

/**
 * The v2 scene is one photo cut into two layers (1:1 scene, see home-hero-v2.css):
 * the sky and the big lit dune behind the window, and the lower dune band in front of it.
 * Both themes show the night dunes. Only the docs window changes: it shows docs.doxa.so
 * in the same theme as the page.
 */
export const HERO_V2_IMAGES = {
  back: { files: sameInBothThemes(pictureFiles("/marketing/hero/dunes-back", DUNE_WIDTHS, 1440)), width: 4096, height: 3776 },
  front: { files: sameInBothThemes(pictureFiles("/marketing/hero/dunes-front", DUNE_WIDTHS, 1440)), width: 4096, height: 1195 },
  docs: { files: themedPictureFiles("/marketing/hero/docs-shot", DOCS_WIDTHS, 2080), width: 2080, height: 1300 },
} as const satisfies Record<string, HeroImage>

/**
 * Rendered widths, for `sizes`. The scene is the page width, but at least 1440px, and
 * narrower screens scale it so the docs window keeps a 16px margin on each side. The
 * window stops at 1440px, then grows with half the page.
 */
export const HERO_V2_SCENE_SIZES = "(max-width: 1072px) 139vw, (max-width: 1440px) 1440px, 100vw"
export const HERO_V2_DOCS_SIZES =
  "(max-width: 1072px) calc(100vw - 32px), (max-width: 1440px) 1040px, (max-width: 1994px) 72vw, (max-width: 2880px) 1440px, 50vw"
