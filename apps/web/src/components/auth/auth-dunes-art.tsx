import { ThemedPicture } from "~/components/ui/themed-picture"
import { type PictureFiles, pictureFiles, sameInBothThemes, themedPictureFiles } from "~/lib/theme/picture-files"
import type { Themed } from "~/lib/theme/theme"
import { cn } from "~/lib/utils"

interface DunesPhoto {
  /** The night photo, and its daylight copy when one exists. */
  files: Themed<PictureFiles>
  /** The photo's own color, under it while it loads. */
  fill: string
  /** How much the photo is darkened, so it sits in the page. */
  imageClass: string
  /** How far down the sky fades into the page. */
  skyFadeClass: string
  /** How far the edge next to the form fades into the page. */
  edgeFadeClass: string
  /** Which part of the photo stays in view when the panel crops it. */
  positionClass: string
}

/** The first three photos have no AVIF files and no daylight copy. */
function nightOnly(base: string): Themed<PictureFiles> {
  const { webp, fallback } = pictureFiles(base, [768, 1280], 768)
  return sameInBothThemes({ webp, fallback })
}

const DUNES_PHOTOS = {
  /** The first photo: a bright blue sky, darkened a lot. */
  dusk: {
    files: nightOnly("/auth/dunes"),
    fill: "bg-[#0f0d17]",
    imageClass: "brightness-[0.78] saturate-[0.9]",
    skyFadeClass: "h-[45%]",
    edgeFadeClass: "w-2/5",
    positionClass: "object-[50%_60%]",
  },
  /** The second photo: a night sky that is already dark, so it needs less. */
  night: {
    files: nightOnly("/auth/dunes-night"),
    fill: "bg-[#110c0d]",
    imageClass: "brightness-[0.92]",
    skyFadeClass: "h-[30%]",
    edgeFadeClass: "w-2/5",
    positionClass: "object-[50%_60%]",
  },
  /** The third photo: someone at an old computer in a night meadow, left of center. */
  meadow: {
    files: nightOnly("/auth/dunes-meadow"),
    fill: "bg-[#191212]",
    imageClass: "brightness-[0.95]",
    skyFadeClass: "h-[22%]",
    edgeFadeClass: "w-1/4",
    positionClass: "object-[55%_45%]",
  },
  /**
   * The third photo again, in a deeper blue, with text on the screen. The daylight
   * copy is a Seedream 4 relight of it, graded to the light page, so it is not darkened.
   */
  meadowBlue: {
    files: themedPictureFiles("/auth/meadow-blue", [480, 800, 1200, 1600], 800),
    fill: "bg-[#15180c] theme-light:bg-[#f5f8f5]",
    imageClass: "brightness-[0.92] theme-light:brightness-100",
    skyFadeClass: "h-[22%]",
    edgeFadeClass: "w-1/4",
    positionClass: "object-[55%_50%]",
  },
} as const satisfies Record<string, DunesPhoto>

/** The photo on show: "dusk", "night", "meadow" or "meadowBlue". */
const DUNES_PHOTO: keyof typeof DUNES_PHOTOS = "meadowBlue"

/** The panel is a third of the window and hidden below `md`. */
const PANEL_SIZES = "33vw"

/**
 * A landscape photo, set into the auth panel: a night photo, or its daylight copy
 * in the light theme. Three gradients fade the photo into the page: the sky at the
 * top, the edge next to the form, and the foot. The fill under the photo is its own
 * color, so the panel never flashes before the image loads.
 *
 * `ThemedPicture` loads lazily, which keeps phones from downloading the photo: the
 * panel is hidden there.
 */
export function AuthDunesArt({ className }: { className?: string }) {
  const photo: DunesPhoto = DUNES_PHOTOS[DUNES_PHOTO]
  return (
    <div className={cn(photo.fill, className)} aria-hidden="true">
      <ThemedPicture
        files={photo.files}
        sizes={PANEL_SIZES}
        alt=""
        width={1280}
        height={2280}
        decoding="async"
        className={cn("size-full object-cover", photo.positionClass, photo.imageClass)}
      />
      <div className={cn("absolute inset-x-0 top-0 bg-linear-to-b from-background via-background/60 to-transparent", photo.skyFadeClass)} />
      <div className={cn("absolute inset-y-0 left-0 bg-linear-to-r from-background via-background/50 to-transparent", photo.edgeFadeClass)} />
      <div className="absolute inset-x-0 bottom-0 h-1/4 bg-linear-to-t from-background to-transparent" />
    </div>
  )
}
