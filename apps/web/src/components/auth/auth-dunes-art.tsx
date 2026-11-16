import { cn } from "~/lib/utils"

interface DunesPhoto {
  src: string
  srcSet: string
  /** Smaller AVIF files for browsers that read them. The WebP `srcSet` is the fallback. */
  avifSrcSet?: string
  /** The photo's own dark color, under it while it loads. */
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

const DUNES_PHOTOS = {
  /** The first photo: a bright blue sky, darkened a lot. */
  dusk: {
    src: "/auth/dunes-768.webp",
    srcSet: "/auth/dunes-768.webp 768w, /auth/dunes-1280.webp 1280w",
    fill: "bg-[#0f0d17]",
    imageClass: "brightness-[0.78] saturate-[0.9]",
    skyFadeClass: "h-[45%]",
    edgeFadeClass: "w-2/5",
    positionClass: "object-[50%_60%]",
  },
  /** The second photo: a night sky that is already dark, so it needs less. */
  night: {
    src: "/auth/dunes-night-768.webp",
    srcSet: "/auth/dunes-night-768.webp 768w, /auth/dunes-night-1280.webp 1280w",
    fill: "bg-[#110c0d]",
    imageClass: "brightness-[0.92]",
    skyFadeClass: "h-[30%]",
    edgeFadeClass: "w-2/5",
    positionClass: "object-[50%_60%]",
  },
  /** The third photo: someone at an old computer in a night meadow, left of center. */
  meadow: {
    src: "/auth/dunes-meadow-768.webp",
    srcSet: "/auth/dunes-meadow-768.webp 768w, /auth/dunes-meadow-1280.webp 1280w",
    fill: "bg-[#191212]",
    imageClass: "brightness-[0.95]",
    skyFadeClass: "h-[22%]",
    edgeFadeClass: "w-1/4",
    positionClass: "object-[55%_45%]",
  },
  /** The third photo again, in a deeper blue, with text on the screen. */
  meadowBlue: {
    src: "/auth/meadow-blue-800.webp",
    srcSet: "/auth/meadow-blue-480.webp 480w, /auth/meadow-blue-800.webp 800w, /auth/meadow-blue-1200.webp 1200w, /auth/meadow-blue-1600.webp 1600w",
    avifSrcSet: "/auth/meadow-blue-480.avif 480w, /auth/meadow-blue-800.avif 800w, /auth/meadow-blue-1200.avif 1200w, /auth/meadow-blue-1600.avif 1600w",
    fill: "bg-[#15180c]",
    imageClass: "brightness-[0.92]",
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
 * A night landscape photo, set into the auth panel. Three gradients fade
 * the photo into the page: the sky at the top, the edge next to the form, and
 * the foot. The fill under the photo is its own dark color, so the panel never
 * flashes before the image loads.
 *
 * `loading="lazy"` keeps phones from downloading it: the panel is hidden there.
 */
export function AuthDunesArt({ className }: { className?: string }) {
  const photo: DunesPhoto = DUNES_PHOTOS[DUNES_PHOTO]
  return (
    <div className={cn(photo.fill, className)} aria-hidden="true">
      <picture>
        {photo.avifSrcSet ? <source type="image/avif" srcSet={photo.avifSrcSet} sizes={PANEL_SIZES} /> : null}
        <img
          src={photo.src}
          srcSet={photo.srcSet}
          sizes={PANEL_SIZES}
          alt=""
          width={1280}
          height={2280}
          loading="lazy"
          decoding="async"
          className={cn("size-full object-cover", photo.positionClass, photo.imageClass)}
        />
      </picture>
      <div className={cn("absolute inset-x-0 top-0 bg-linear-to-b from-background via-background/60 to-transparent", photo.skyFadeClass)} />
      <div className={cn("absolute inset-y-0 left-0 bg-linear-to-r from-background via-background/50 to-transparent", photo.edgeFadeClass)} />
      <div className="absolute inset-x-0 bottom-0 h-1/4 bg-linear-to-t from-background to-transparent" />
    </div>
  )
}
