import type { MouseEvent } from "react"

import { ArtToggle } from "~/components/marketing/art-toggle"
import { useSolveArt } from "~/lib/marketing/use-solve-art"

/**
 * The right column of the home hero. Two robotic hands solve a cube, in plain WebGL2,
 * and the canvas is wider than the column so that the hands and arms can reach past it.
 * Without WebGL2, the column stays empty over the aurora.
 *
 * A click on the column pauses or resumes the art. The Pause button is hidden until it
 * gets keyboard focus, so keyboard and screen reader users can still stop the motion.
 */
/** The hero art is 20% smaller than the default, so the copy beside it reads first. */
const HERO_ART_SCALE = 0.8

export function HeroSolve() {
  const { canvas, stage, playing, toggle } = useSolveArt({ scale: HERO_ART_SCALE })

  const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (playing === null) return
    // A click on a button inside the column is that button's own action.
    if ((event.target as Element).closest("button, a")) return
    toggle()
  }

  return (
    <div
      ref={stage}
      className={`hero__stage vdiv${playing === null ? "" : " is-toggleable"}`}
      onClick={onStageClick}
    >
      <canvas ref={canvas} className="hero__solve" aria-hidden="true" />
      {playing === null ? null : <ArtToggle playing={playing} onToggle={toggle} className="hero__solve-toggle" />}
    </div>
  )
}
