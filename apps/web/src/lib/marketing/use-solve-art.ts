import { useCallback, useEffect, useRef, useState } from "react"

import { attachSolveArt, type SolveArt } from "~/lib/marketing/solve-art"

/** Start the art one screen before it arrives, so it never draws in view. */
const ATTACH_MARGIN = "100% 0px"

/**
 * Attaches the robotic hands that solve a cube. `canvas` is where they draw and `stage`
 * is the area that the cube centers over. `playing` is null until the art has drawn, so
 * a button never controls art that is not there.
 */
export function useSolveArt() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const art = useRef<SolveArt | null>(null)
  const [playing, setPlaying] = useState<boolean | null>(null)

  const toggle = useCallback(() => {
    if (!art.current) return
    art.current.setPlaying(!art.current.playing)
    setPlaying(art.current.playing)
  }, [])

  useEffect(() => {
    const surface = canvas.current
    const area = stage.current
    if (!surface || !area) return
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        near.disconnect()
        art.current = attachSolveArt(surface, area)
        if (art.current) setPlaying(art.current.playing)
      },
      { rootMargin: ATTACH_MARGIN },
    )
    near.observe(surface)
    return () => {
      near.disconnect()
      art.current?.stop()
      art.current = null
    }
  }, [])

  return { canvas, stage, playing, toggle }
}
