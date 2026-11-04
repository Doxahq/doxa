import { CAMERA_ELEVATION, heroLayout, SEEN_SHARE } from "~/lib/marketing/frisbee-art/flight"
import { listenForPokes, spotHand, type HandLine } from "~/lib/marketing/frisbee-art/poke"
import { ARM_FADE_FAR, ARM_FADE_NEAR, createFrisbeeScene } from "~/lib/marketing/frisbee-art/scene"
import { startArtLoop, type ArtLoop } from "~/lib/marketing/solve-art/loop"
import { budgetedPixelRatio, orbitCamera, type Vec3 } from "~/lib/marketing/solve-art/math"
import { createRenderer } from "~/lib/marketing/solve-art/renderer"

const FAR_PAST_SCENE = 110
const MAX_PIXEL_RATIO = 1.5
/** The most pixels in the canvas. This hero is most of the first screen of the site, so it stays light. */
const MAX_PIXELS = 2_400_000
/** How far a hand reaches from its middle line, for a click: in world units, and at least in CSS pixels. */
const HAND_REACH_UNITS = 2.8
const MIN_HAND_REACH_PIXELS = 22

export type FrisbeeArt = ArtLoop

/**
 * Draws two robotic hands that throw a disc across the hero, in `canvas`, with the
 * hands in the empty space beside `content`. It plays by itself and loops. When the
 * visitor stops seeing it, a disc in flight first reaches a hand, and the art then
 * waits until the visitor sees it again. A click on a hand knocks it, and the hand
 * gets angry at the visitor.
 *
 * Returns null when the browser has no WebGL2.
 */
export function attachFrisbeeArt(canvas: HTMLCanvasElement, content: HTMLElement): FrisbeeArt | null {
  const renderer = createRenderer(canvas, null)
  if (!renderer) return null

  const scene = createFrisbeeScene()
  const viewProj = new Float32Array(16)
  let camera = { focal: 1, aspect: 1, distance: 64, far: 180 }
  let box = { width: 0, height: 0 }
  let unit = 1

  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    box = { width: rect.width, height: rect.height }
    const ratio = budgetedPixelRatio(window.devicePixelRatio, rect.width, rect.height, MAX_PIXEL_RATIO, MAX_PIXELS)
    const width = Math.round(rect.width * ratio)
    const height = Math.round(rect.height * ratio)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const gutter = Math.max(0, content.getBoundingClientRect().left - rect.left)
    const layout = heroLayout(rect.width, rect.height, gutter)
    unit = layout.unit
    scene.setField(layout.field)
    camera = {
      focal: (2 * layout.distance * layout.unit) / rect.height,
      aspect: rect.width / rect.height,
      distance: layout.distance,
      far: layout.distance + FAR_PAST_SCENE,
    }
  }

  const draw = () => {
    const eye = orbitCamera(viewProj, { ...camera, azimuth: 0, elevation: CAMERA_ELEVATION, shiftX: 0, shiftY: 0 })
    renderer.begin()
    scene.draw(renderer.sink, renderer.occluders)
    renderer.setArmFade(scene.wrists, ARM_FADE_NEAR, ARM_FADE_FAR)
    renderer.flush(viewProj, eye, 0)
  }

  /** Where a point of the scene is on the canvas, in CSS pixels. */
  const onCanvas = ([x, y, z]: Vec3): [number, number] => {
    const m = viewProj
    const w = m[3] * x + m[7] * y + m[11] * z + m[15]
    return [(((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2) * box.width, ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2) * box.height]
  }
  const lineOf = (hand: 0 | 1): HandLine => {
    const [from, to] = scene.handLine(hand)
    return [onCanvas(from), onCanvas(to)]
  }

  const loop = startArtLoop(canvas, { resize, update: scene.update, draw, secondsToRest: scene.secondsToRest }, { seenShare: SEEN_SHARE })
  const host = canvas.parentElement
  const stopPokes = host
    ? listenForPokes({
        host,
        canvas,
        content,
        active: () => loop.playing,
        find: (x, y) => spotHand(x, y, [lineOf(0), lineOf(1)], Math.max(MIN_HAND_REACH_PIXELS, HAND_REACH_UNITS * unit)),
        kick: (spot) => scene.kick(spot.hand, spot.x, spot.y),
      })
    : () => {}

  return {
    get playing() {
      return loop.playing
    },
    setPlaying: loop.setPlaying,
    stop() {
      stopPokes()
      loop.stop()
    },
  }
}
