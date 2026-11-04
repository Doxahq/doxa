import { useEffect, useRef, useState } from "react"

import { ArtToggle } from "~/components/marketing/art-toggle"
import type { FrisbeeArt } from "~/lib/marketing/frisbee-art"

/** Below this width, the space beside the hero copy is too small for the hands. Keep in sync with about.css. */
const WIDE_ENOUGH = "(min-width: 1400px)"

/**
 * Two robotic hands in the empty space at each side of the hero throw a disc to each
 * other, behind the hero content. It adds no layout: the canvas and the button are
 * absolute. The art code loads only on a window that is wide enough. Without WebGL2,
 * the hero stays as it is. The button stays hidden until the art has drawn.
 */
export function HeroFrisbee() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const art = useRef<FrisbeeArt | null>(null)
  const [playing, setPlaying] = useState<boolean | null>(null)

  const toggle = () => {
    if (!art.current) return
    art.current.setPlaying(!art.current.playing)
    setPlaying(art.current.playing)
  }

  useEffect(() => {
    const surface = canvas.current
    const content = surface?.parentElement?.querySelector<HTMLElement>(".ab-hero")
    if (!surface || !content) return
    let cancelled = false
    let started = false
    const wide = window.matchMedia(WIDE_ENOUGH)
    const start = () => {
      if (started || !wide.matches) return
      started = true
      void import("~/lib/marketing/frisbee-art").then(({ attachFrisbeeArt }) => {
        if (cancelled) return
        art.current = attachFrisbeeArt(surface, content)
        if (art.current) setPlaying(art.current.playing)
      })
    }
    wide.addEventListener("change", start)
    start()
    return () => {
      cancelled = true
      wide.removeEventListener("change", start)
      art.current?.stop()
      art.current = null
    }
  }, [])

  return (
    <>
      <canvas ref={canvas} className="hero__frisbee" aria-hidden="true" />
      {playing === null ? null : <ArtToggle playing={playing} onToggle={toggle} className="hero__frisbee-toggle" />}
    </>
  )
}
