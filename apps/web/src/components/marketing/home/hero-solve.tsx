import { ArtToggle } from "~/components/marketing/art-toggle"
import { useSolveArt } from "~/lib/marketing/use-solve-art"

/**
 * The right column of the home hero. Two robotic hands solve a cube, in plain WebGL2,
 * and the canvas is wider than the column so that the hands and arms can reach past it.
 * Without WebGL2, the column stays empty over the aurora.
 */
export function HeroSolve() {
  const { canvas, stage, playing, toggle } = useSolveArt()

  return (
    <div ref={stage} className="hero__stage vdiv">
      <canvas ref={canvas} className="hero__solve" aria-hidden="true" />
      {playing === null ? null : <ArtToggle playing={playing} onToggle={toggle} className="hero__solve-toggle" />}
    </div>
  )
}
