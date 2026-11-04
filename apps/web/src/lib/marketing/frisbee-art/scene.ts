import { createFrisbeeTimeline, DISC_RADIUS, PALM_FROM_DISC, type DiscPose, type Field, type HandIndex, type HandPose } from "~/lib/marketing/frisbee-art/flight"
import { reach } from "~/lib/marketing/frisbee-art/motion"
import { ANIMATION_SPEED } from "~/lib/marketing/frisbee-art/settings"
import { invert, invertTo, multiply, rigid, rotateX, rotateY, rotateZ, transformPoint, translate, type Rigid, type Vec3 } from "~/lib/marketing/solve-art/math"
import { buildHand, drawHand, MATERIAL, standardFingers, writeWrist, type HandRig, type PartSink, type Rgb } from "~/lib/marketing/solve-art/rig"

/** The disc looks like the Doxa logo: off-white with a dark dot. */
const DISC_SHELL: Rgb = [0.91, 0.9, 0.867]
const DISC_UNDER: Rgb = [0.16, 0.16, 0.18]
const DISC_DOT: Rgb = [0.1, 0.1, 0.094]
/** The theme accent, #3d7bff. The marks show the spin. */
const DISC_MARK: Rgb = [0.239, 0.482, 1]
const FINGERS = 5
/** A half turn of one side of the cylinder mesh, so two of them draw a rounder disc. */
const HALF_SIDE = Math.PI / 14
const THIRD = (Math.PI * 2) / 3

/**
 * Where each fingertip closes on the disc of the hand on the -x side, in disc space:
 * index, middle, ring, little, thumb. The thumb is on top, and the fingers curl under
 * the rim. The hand on the +x side mirrors them.
 */
const CLOSED: readonly Vec3[] = [
  [-1.42, -0.24, 1.02],
  [-1.71, -0.24, 0.38],
  [-1.72, -0.24, -0.31],
  [-1.49, -0.24, -0.92],
  [-1.52, 0.26, 0.31],
]

/**
 * The hand in disc space, for the hand on the -x side. It holds the rim from the
 * outside and from below. Its palm faces up and away, and its back faces the camera.
 */
const PALM: Vec3 = [-PALM_FROM_DISC, -1.05, 0.2]
const TOWARD_KNUCKLES: Vec3 = [0.96, 0.14, -0.22]
const BACK_OF_HAND: Vec3 = [-0.06, -0.72, 0.68]

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]]

/** The frame of a hand in disc space, for the side `s`. Exported for the tests. */
export function gripFrame(s: 1 | -1): Rigid {
  const m = -s
  const z = normalize([TOWARD_KNUCKLES[0] * m, TOWARD_KNUCKLES[1], TOWARD_KNUCKLES[2]])
  const back: Vec3 = [BACK_OF_HAND[0] * m, BACK_OF_HAND[1], BACK_OF_HAND[2]]
  const along = back[0] * z[0] + back[1] * z[1] + back[2] * z[2]
  const y = normalize([back[0] - z[0] * along, back[1] - z[1] * along, back[2] - z[2] * along])
  const x = cross(y, z)
  return Float32Array.of(x[0], y[0], z[0], PALM[0] * m, x[1], y[1], z[1], PALM[1], x[2], y[2], z[2], PALM[2])
}

/** The side of each hand: hand 0 is on -x. */
export const SIDES: readonly [1 | -1, 1 | -1] = [-1, 1]
/** Half the length of a forearm. It is long enough that its end always sinks into the page. */
const ARM = 9
/** The elbow, from the point that holds the disc at rest: out, down and behind the hand. */
const ELBOW: Vec3 = [17, -5.5, -5]
/** How much of the motion of the hand the elbow takes. The forearm turns around the rest of it. */
const ELBOW_FOLLOW = 0.42
/** Where a forearm starts to sink into the page, and where it is gone, from its wrist. */
export const ARM_FADE_NEAR = 3.5
export const ARM_FADE_FAR = 8.5

/** The hand on the side `s`, the same hand as on the About page. */
export function frisbeeHand(s: 1 | -1): HandRig {
  // In the grip frame, hand-space x points up on the -x side and down on the +x side.
  const side = (s === 1 ? -1 : 1) as 1 | -1
  return buildHand({ anchor: [s * ELBOW[0], ELBOW[1], ELBOW[2]], side, fingers: standardFingers(side), arm: ARM, armMaterial: MATERIAL.fadingShell })
}

/** How far the elbow drops when the hand stands up for the trick, so that the forearm comes up to it. */
const ELBOW_DROP = 7

/** Sets where the elbow of a hand is, for this pose. Exported for the tests. */
export function elbowAt(out: [number, number, number], hand: HandPose, s: 1 | -1, field: Field): void {
  const restX = s * (field.span + DISC_RADIUS)
  out[0] = restX + (hand.x - restX) * ELBOW_FOLLOW + s * ELBOW[0]
  out[1] = hand.y * ELBOW_FOLLOW + ELBOW[1] - Math.max(hand.point, hand.stand) * ELBOW_DROP
  out[2] = hand.z * ELBOW_FOLLOW + ELBOW[2]
}

/** Where the fingers of a hand close, in hand space. Exported for the tests. */
export function closedTargets(s: 1 | -1, grip: Rigid): Float32Array {
  const toHand = invert(grip)
  const out = new Float32Array(FINGERS * 3)
  CLOSED.forEach(([cx, cy, cz], f) => {
    const x = cx * -s
    out[f * 3] = toHand[0] * x + toHand[1] * cy + toHand[2] * cz + toHand[3]
    out[f * 3 + 1] = toHand[4] * x + toHand[5] * cy + toHand[6] * cz + toHand[7]
    out[f * 3 + 2] = toHand[8] * x + toHand[9] * cy + toHand[10] * cz + toHand[11]
  })
  return out
}

/** The order in which the fingers let go: the little finger first, the index and thumb last. */
const RELEASE_ORDER = [3, 2, 1, 0, 2.5]
const STAGGER = 0.14

/** How far an open hand stays below the disc, so that the fingers close under the rim and the thumb on top. */
const OPEN_DROP = 1.1
/**
 * How high the center of the disc is above the middle line of the hand, in hand space,
 * where it rests on the back of the hand: low on the fingers, and higher on the plates.
 */
export function backHeight(along: number): number {
  return 0.44 + (0.68 - 0.44) * reach((4.4 - along) / 3)
}

/** How the hand moves for the spin trick, in disc space on the -x side, so that the raised index is straight. */
const POINT_SHIFT: Vec3 = [-0.39, -0.36, 0.18]

const wristM = rigid()

/** Sets the frame of a hand from its pose. Exported for the tests. */
export function handFrame(out: Rigid, hand: HandPose, grip: Rigid): Rigid {
  out.set(rigid())
  translate(out, out, hand.x, hand.y, hand.z)
  rotateX(out, out, hand.bank)
  rotateZ(out, out, hand.nose)
  translate(out, out, 0, -hand.open * OPEN_DROP * (1 - Math.max(hand.point, hand.flat, hand.stand, hand.claw)), 0)
  // The palm of a hand on the -x side has a negative x in its grip.
  translate(out, out, POINT_SHIFT[0] * hand.point * (grip[3] < 0 ? 1 : -1), POINT_SHIFT[1] * hand.point, POINT_SHIFT[2] * hand.point)
  if (hand.roll !== 0) rotateX(out, out, hand.roll)
  if (hand.slide > 0) {
    // The place on the back of the hand comes to the point that holds the disc.
    const y = backHeight(hand.along)
    const z = hand.along
    translate(
      out,
      out,
      -hand.slide * (grip[1] * y + grip[2] * z + grip[3]),
      -hand.slide * (grip[5] * y + grip[6] * z + grip[7]),
      -hand.slide * (grip[9] * y + grip[10] * z + grip[11]),
    )
  }
  rotateY(wristM, out, hand.wrist)
  return multiply(out, wristM, grip)
}

/** Fills `targets` with where each fingertip goes, in hand space. Exported for the tests. */
export function handTargets(targets: Float32Array, rig: HandRig, closed: Float32Array, open: number): void {
  for (let f = 0; f < FINGERS; f++) {
    const k = Math.min(1, Math.max(0, open * (1 + STAGGER * 3) - RELEASE_ORDER[f] * STAGGER))
    for (let i = 0; i < 3; i++) {
      const at = f * 3 + i
      targets[at] = closed[at] + (rig.relaxed[at] - closed[at]) * k
    }
  }
}

/** Fans the fingers out and opens the thumb wide, as far as the pose asks, for a hand that pushes. */
function pushFingers(targets: Float32Array, rig: HandRig, hand: HandPose): void {
  if (hand.push <= 0) return
  for (let f = 0; f < FINGERS; f++) {
    const { base, lengths } = rig.fingers[f]
    const thumb = f === FINGERS - 1
    const x = thumb ? rig.side * 3.1 : base[0] * 1.42
    const y = thumb ? -0.42 : base[1] - 0.08
    const z = thumb ? 1.95 : base[2] + (lengths[0] + lengths[1] + lengths[2]) * 0.965
    targets[f * 3] += (x - targets[f * 3]) * hand.push
    targets[f * 3 + 1] += (y - targets[f * 3 + 1]) * hand.push
    targets[f * 3 + 2] += (z - targets[f * 3 + 2]) * hand.push
  }
}

/** Spreads the fingers wide and tense, as far as the pose asks, for the angry "why?!". */
function clawFingers(targets: Float32Array, rig: HandRig, hand: HandPose): void {
  if (hand.claw <= 0) return
  const c = hand.clench
  for (let f = 0; f < FINGERS; f++) {
    const { base, lengths } = rig.fingers[f]
    const length = lengths[0] + lengths[1] + lengths[2]
    const thumb = f === FINGERS - 1
    const x = thumb ? rig.side * (3.2 - 0.7 * c) : base[0] * 1.55
    const y = thumb ? -0.5 - 1 * c : base[1] - 0.3 - 1.25 * c
    const z = thumb ? 2 + 0.5 * c : base[2] + length * (0.93 - 0.28 * c)
    targets[f * 3] += (x - targets[f * 3]) * hand.claw
    targets[f * 3 + 1] += (y - targets[f * 3 + 1]) * hand.claw
    targets[f * 3 + 2] += (z - targets[f * 3 + 2]) * hand.claw
  }
}

/** Straightens the fingers, as far as the pose asks, for a flat hand with its back up. */
function flattenFingers(targets: Float32Array, rig: HandRig, hand: HandPose): void {
  if (hand.flat <= 0) return
  for (let f = 0; f < FINGERS; f++) {
    const { base, lengths } = rig.fingers[f]
    const thumb = f === FINGERS - 1
    // The thumb lies straight beside the hand, below the disc.
    const x = thumb ? rig.side * 1.8 : base[0] * 1.03
    const y = thumb ? -0.42 : base[1] - 0.2
    const z = thumb ? 2.95 : base[2] + (lengths[0] + lengths[1] + lengths[2]) * 0.985
    targets[f * 3] += (x - targets[f * 3]) * hand.flat
    targets[f * 3 + 1] += (y - targets[f * 3 + 1]) * hand.flat
    targets[f * 3 + 2] += (z - targets[f * 3 + 2]) * hand.flat
  }
}

/**
 * Where the fingertips go in the trick, in hand space, for a hand with its index and
 * thumb on the +x side: a fist with the index out. The hand on the other side mirrors
 * them. The index has no place here, because it goes to the disc.
 */
const FIST: readonly Vec3[] = [
  [1.06, -0.6, 4.2],
  [0.42, -1, 0.95],
  [-0.3, -1, 0.95],
  [-0.96, -0.95, 0.85],
  [0.62, -1.15, 1.35],
]
/** The fingertip touches the underside of the disc, this far below its center. */
const TIP_UNDER_DISC = 0.26

const toHandM = rigid()

/** Turns the fingers toward the trick, as far as the pose asks. Exported for the tests. */
export function pointFingers(targets: Float32Array, rig: HandRig, frame: Rigid, hand: HandPose): void {
  if (hand.point <= 0) return
  invertTo(toHandM, frame)
  const wy = hand.y - TIP_UNDER_DISC - hand.gap
  for (let f = 0; f < FINGERS; f++) {
    const [fx, fy, fz] = FIST[f]
    let x = fx * rig.side
    let y = fy
    let z = fz
    if (f === 0) {
      const m = toHandM
      x = m[0] * hand.x + m[1] * wy + m[2] * hand.z + m[3]
      y = m[4] * hand.x + m[5] * wy + m[6] * hand.z + m[7]
      z = m[8] * hand.x + m[9] * wy + m[10] * hand.z + m[11]
    }
    targets[f * 3] += (x - targets[f * 3]) * hand.point
    targets[f * 3 + 1] += (y - targets[f * 3 + 1]) * hand.point
    targets[f * 3 + 2] += (z - targets[f * 3 + 2]) * hand.point
  }
}

const discM = rigid()
const spunM = rigid()
const partM = rigid()

function drawDisc(sink: PartSink, disc: DiscPose): void {
  discM.set(rigid())
  translate(discM, discM, disc.x, disc.y, disc.z)
  rotateX(discM, discM, disc.bank)
  rotateZ(discM, discM, disc.nose)
  rotateY(spunM, discM, disc.spin)
  // Two cylinders, a half side apart, draw a rounder edge with no extra mesh.
  for (const turn of [0, HALF_SIDE]) {
    rotateY(partM, spunM, turn)
    sink.cylinder(partM, DISC_RADIUS, 0.16, 0.1, DISC_SHELL, MATERIAL.sticker)
    translate(partM, partM, 0, 0.13, 0)
    sink.cylinder(partM, DISC_RADIUS * 0.82, 0.08, 0.06, DISC_SHELL, MATERIAL.sticker)
    rotateY(partM, spunM, turn)
    translate(partM, partM, 0, -0.12, 0)
    sink.cylinder(partM, DISC_RADIUS * 0.84, 0.08, 0.02, DISC_UNDER, MATERIAL.core)
  }
  translate(partM, spunM, 0, 0.215, 0)
  sink.cylinder(partM, 0.62, 0.012, 0.006, DISC_DOT, MATERIAL.core)
  // The marks near the rim show the spin.
  for (let i = 0; i < 3; i++) {
    rotateY(partM, spunM, i * THIRD)
    translate(partM, partM, 0, 0.215, DISC_RADIUS * 0.66)
    sink.box(partM, 0.09, 0.012, 0.36, 0.006, DISC_MARK, MATERIAL.light)
  }
}

/** The middle line of a hand, for a click: from behind its wrist to its fingertips, in hand space. */
const LINE_FROM_Z = -2.4
const LINE_TO_Z = 4.8

export interface FrisbeeScene {
  update(seconds: number): void
  /** The seconds until a hand holds the disc and waits, and 0 while a hand waits. */
  secondsToRest(): number
  /** Hits a hand. `x` and `y` are the way of the hit on the screen, with y up and a length of 1. */
  kick(hand: HandIndex, x: number, y: number): void
  /** The middle line of a hand in the last frame, in world space. */
  handLine(hand: HandIndex): [Vec3, Vec3]
  /** Sets the size of the hero in world units. */
  setField(field: Field): void
  /** Writes the frame to the sink, and the occluders as x, y, z, radius. */
  draw(sink: PartSink, occluders: Float32Array): void
  /** The wrists of the last frame, three values each, for the fade of the arms. */
  readonly wrists: Float32Array
}

const frames = [rigid(), rigid()]
const targetsOf = [new Float32Array(FINGERS * 3), new Float32Array(FINGERS * 3)]
const tips = new Float32Array(30)
const wrists = new Float32Array(6)

function writeOccluders(out: Float32Array): void {
  for (let h = 0; h < 2; h++) {
    out[h * 4] = frames[h][3]
    out[h * 4 + 1] = frames[h][7]
    out[h * 4 + 2] = frames[h][11]
    out[h * 4 + 3] = 2.4
  }
  for (let i = 0; i < 10; i++) {
    out[8 + i * 4] = tips[i * 3]
    out[9 + i * 4] = tips[i * 3 + 1]
    out[10 + i * 4] = tips[i * 3 + 2]
    out[11 + i * 4] = 0.42
  }
}

/**
 * The whole scene: two hands that throw a disc back and forth. Each page load gets a
 * new order of throws and tricks, unless a test gives it a `seed`.
 */
export function createFrisbeeScene({ seed = Math.floor(Math.random() * 2 ** 31) }: { seed?: number } = {}): FrisbeeScene {
  const timeline = createFrisbeeTimeline({ seed, speed: ANIMATION_SPEED })
  const grips = [gripFrame(-1), gripFrame(1)]
  const rigs = [frisbeeHand(-1), frisbeeHand(1)]
  const closed = [closedTargets(-1, grips[0]), closedTargets(1, grips[1])]
  const elbows: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
  ]
  rigs[0].anchor = elbows[0]
  rigs[1].anchor = elbows[1]
  let world: Field = { span: 27, top: 19.5, depth: 2, floor: -19.5, inner: 28, edge: 58 }

  return {
    update(seconds) {
      timeline.advance(seconds)
    },
    secondsToRest: () => timeline.secondsToRest(),
    kick: (hand, x, y) => timeline.kick(hand, x, y),
    handLine: (hand) => [transformPoint(frames[hand], 0, 0, LINE_FROM_Z), transformPoint(frames[hand], 0, 0, LINE_TO_Z)],
    setField(next) {
      world = next
    },
    draw(sink, occluders) {
      timeline.write(world)
      const { disc, hands } = timeline
      drawDisc(sink, disc)
      for (const h of [0, 1] as HandIndex[]) {
        const s = SIDES[h]
        elbowAt(elbows[h], hands[h], s, world)
        handFrame(frames[h], hands[h], grips[h])
        handTargets(targetsOf[h], rigs[h], closed[h], hands[h].open)
        flattenFingers(targetsOf[h], rigs[h], hands[h])
        pushFingers(targetsOf[h], rigs[h], hands[h])
        clawFingers(targetsOf[h], rigs[h], hands[h])
        pointFingers(targetsOf[h], rigs[h], frames[h], hands[h])
        drawHand(sink, rigs[h], frames[h], targetsOf[h], 0.3 + 0.7 * Math.max(1 - hands[h].open, hands[h].point, hands[h].flat, hands[h].stand, hands[h].claw) + hands[h].glow, tips, h * 15)
        writeWrist(wrists, h * 3, frames[h])
      }
      writeOccluders(occluders)
    },
    wrists,
  }
}
