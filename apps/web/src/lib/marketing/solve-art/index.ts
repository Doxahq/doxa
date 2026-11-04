import { startArtLoop, type ArtLoop } from "~/lib/marketing/solve-art/loop"
import { budgetedPixelRatio, orbitCamera } from "~/lib/marketing/solve-art/math"
import { createRenderer } from "~/lib/marketing/solve-art/renderer"
import { createSolveScene } from "~/lib/marketing/solve-art/scene"

/** The camera faces the cuber, a little from above, as in a filmed solve. */
const AZIMUTH = 0.2
const ELEVATION = 0.3
const DISTANCE = 22
/** The cube, as a part of the shorter side of the stage. The hands are about twice as wide as it. */
const CUBE_SHARE = 0.25
const CUBE_MIN_PX = 96
const CUBE_MAX_PX = 190
/** The side of the cube in world units. */
const CUBE_SIDE = 3
/** The sharpest pixel ratio. MSAA keeps the edges clean below it. */
const MAX_PIXEL_RATIO = 1.5
/** The most pixels in the canvas. A very wide window would otherwise hold a large MSAA buffer in GPU memory. */
const MAX_PIXELS = 3_000_000

/** The pixel ratio of the canvas for a window of this size, in CSS pixels. */
export function canvasPixelRatio(deviceRatio: number, width: number, height: number): number {
  return budgetedPixelRatio(deviceRatio, width, height, MAX_PIXEL_RATIO, MAX_PIXELS)
}

export type SolveArt = ArtLoop

/**
 * Draws two robotic hands that solve a cube, in `canvas`, with the cube centered
 * over `stage`. The parts of one frame are about 230 boxes and cylinders, in two
 * instanced draw calls. It plays by itself and loops, and it runs only while the
 * canvas is on screen, so a visitor always arrives at a scrambled cube or a solve.
 *
 * Returns null when the browser has no WebGL2.
 */
export function attachSolveArt(canvas: HTMLCanvasElement, stage: HTMLElement): SolveArt | null {
  const renderer = createRenderer(canvas)
  if (!renderer) {
    // With no art, the empty stage goes too.
    stage.hidden = true
    return null
  }

  const scene = createSolveScene()
  const viewProj = new Float32Array(16)
  let camera = { focal: 1, aspect: 1, shiftX: 0, shiftY: 0 }

  const resize = () => {
    const box = canvas.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return
    const ratio = canvasPixelRatio(window.devicePixelRatio, box.width, box.height)
    const width = Math.round(box.width * ratio)
    const height = Math.round(box.height * ratio)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const area = stage.getBoundingClientRect()
    const cubePx = Math.min(CUBE_MAX_PX, Math.max(CUBE_MIN_PX, Math.min(area.width, area.height) * CUBE_SHARE))
    camera = {
      focal: (cubePx * 2 * DISTANCE) / (CUBE_SIDE * box.height),
      aspect: box.width / box.height,
      shiftX: ((area.left + area.width / 2 - box.left) / box.width) * 2 - 1,
      shiftY: 1 - ((area.top + area.height / 2 - box.top) / box.height) * 2,
    }
  }

  const draw = () => {
    const t = scene.time()
    const eye = orbitCamera(viewProj, {
      ...camera,
      // A slow drift, so the depth reads while the cube rests. It is zero at the first frame.
      azimuth: AZIMUTH + Math.sin(t * 0.13) * 0.09,
      elevation: ELEVATION + Math.sin(t * 0.09) * 0.035,
      distance: DISTANCE,
    })
    renderer.begin()
    scene.draw(renderer.sink, renderer.occluders)
    renderer.flush(viewProj, eye, scene.glow())
  }

  return startArtLoop(canvas, { resize, update: scene.update, draw })
}
