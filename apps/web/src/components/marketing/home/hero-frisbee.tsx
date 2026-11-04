import { useEffect, useRef, useState } from "react"

import type { FrisbeeArt } from "~/lib/marketing/frisbee-art"

const PLAY_PATH = "M0 0 9 5 0 10Z"
const PAUSE_PATH = "M0 0H3V10H0ZM6 0H9V10H6Z"

/** Below this width, the space beside the hero copy is too small for the hands. Keep in sync with home.css. */
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
    const content = surface?.parentElement?.querySelector<HTMLElement>(".hero__grid")
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
      {playing === null ? null : (
        <button type="button" className="btn btn--line btn--sm hero__frisbee-toggle" onClick={toggle}>
          <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
            <path fill="currentColor" d={playing ? PAUSE_PATH : PLAY_PATH} />
          </svg>
          {playing ? "Pause" : "Play"}
        </button>
      )}
    </>
  )
}
