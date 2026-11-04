import { aim, rigid, rotateX, rotateY, rotateZ, transformPoint, translate, type Rigid, type Vec3 } from "~/lib/marketing/solve-art/math"

export type Rgb = readonly [number, number, number]

/** The places that darken a part nearby: two palms and ten fingertips. */
export const OCCLUDERS = 12

/** How the shader lights a part. */
export const MATERIAL = { shell: 0, sticker: 1, light: 2, core: 3, fadingShell: 4 } as const
export type Material = (typeof MATERIAL)[keyof typeof MATERIAL]

/** Takes the parts of the scene for one frame. */
export interface PartSink {
  /** `half` is half the size of the box, and the box tapers toward its +z end. */
  box(m: Rigid, hx: number, hy: number, hz: number, bevel: number, color: Rgb, material: Material, taper?: number): void
  /** The cylinder axis is +y. */
  cylinder(m: Rigid, radius: number, halfHeight: number, bevel: number, color: Rgb, material: Material): void
}

const SHELL: Rgb = [0.2, 0.205, 0.23]
const PLATE: Rgb = [0.33, 0.34, 0.375]
const JOINT: Rgb = [0.055, 0.055, 0.065]
const TIP: Rgb = [0.46, 0.48, 0.53]
/** The theme accent, #3d7bff. */
const ACCENT: Rgb = [0.239, 0.482, 1]

export interface FingerSpec {
  /** Where the finger leaves the palm, in hand space. */
  base: Vec3
  lengths: Vec3
  width: number
}

export interface HandRig {
  /** The point far outside the view that the forearm aims at. */
  anchor: Vec3
  /** The side of the hand that carries the index and the thumb: +1 is +x in hand space. */
  side: 1 | -1
  fingers: FingerSpec[]
  /** Where each fingertip rests in a relaxed, open hand, in hand space: x, y, z. */
  relaxed: Float32Array
  /** Half the length of the forearm. */
  arm: number
  /** How the forearm draws: `fadingShell` sinks into the page at a distance from the wrist. */
  armMaterial: Material
}

const DEFAULT_ARM = 4.9

/**
 * The five fingers that every robotic hand on the site shares: index, middle, ring,
 * little, thumb. The index and the thumb are on the `side` of the hand.
 */
export function standardFingers(side: 1 | -1): FingerSpec[] {
  const finger = (x: number, y: number, z: number, lengths: Vec3, width: number): FingerSpec => ({ base: [side * x, y, z], lengths, width })
  return [
    finger(1.06, -0.06, 1.46, [1.45, 1, 0.8], 0.27),
    finger(0.36, -0.06, 1.55, [1.6, 1.1, 0.85], 0.275),
    finger(-0.34, -0.06, 1.48, [1.45, 1, 0.8], 0.265),
    finger(-1.02, -0.06, 1.28, [1.2, 0.8, 0.65], 0.235),
    finger(1.35, -0.24, -0.7, [1.75, 1.2, 0.95], 0.3),
  ]
}

/** Out of two flex units at the middle joint, the end joint takes this much. */
const END_JOINT = 0.72
const MAX_FLEX = 1.85
const SOLVE_STEPS = 16

function chainX(lengths: Vec3, flex: number): number {
  return lengths[0] + lengths[1] * Math.cos(flex) + lengths[2] * Math.cos(flex * (1 + END_JOINT))
}

function chainY(lengths: Vec3, flex: number): number {
  return lengths[1] * Math.sin(flex) + lengths[2] * Math.sin(flex * (1 + END_JOINT))
}

/**
 * Finds the joint angles that put the fingertip at (x, y, z) in hand space, and writes
 * them as the yaw, the first joint and the flex of the others. A point out of reach
 * gets the nearest pose. Exported for the tests.
 */
export function solveFinger(finger: FingerSpec, x: number, y: number, z: number, out: Float32Array | number[]): void {
  const dx = x - finger.base[0]
  const dy = y - finger.base[1]
  const dz = z - finger.base[2]
  const forward = Math.hypot(dx, dz)
  const down = -dy
  const reach = Math.hypot(forward, down)
  const { lengths } = finger
  // More flex at the middle joint gives a shorter reach. Bisect for the wanted reach.
  let low = 0
  let high = MAX_FLEX
  for (let i = 0; i < SOLVE_STEPS; i++) {
    const mid = (low + high) / 2
    if (Math.hypot(chainX(lengths, mid), chainY(lengths, mid)) > reach) low = mid
    else high = mid
  }
  const flex = (low + high) / 2
  out[0] = Math.atan2(dx, dz)
  out[1] = Math.atan2(down, forward) - Math.atan2(chainY(lengths, flex), chainX(lengths, flex))
  out[2] = flex
}

/** The tip of a finger in hand space, from its joint angles. */
function tipOf(finger: FingerSpec, yaw: number, first: number, flex: number): [number, number, number] {
  const m = rigid()
  translate(m, m, finger.base[0], finger.base[1], finger.base[2])
  rotateY(m, m, yaw)
  rotateX(m, m, first)
  translate(m, m, 0, 0, finger.lengths[0])
  rotateX(m, m, flex)
  translate(m, m, 0, 0, finger.lengths[1])
  rotateX(m, m, flex * END_JOINT)
  translate(m, m, 0, 0, finger.lengths[2])
  return [m[3], m[7], m[11]]
}

/** Joint angles of a relaxed hand: each finger stays curved, and the fingers fan out. */
const RELAXED: readonly (readonly [number, number, number])[] = [
  [0.14, 0.05, 0.42],
  [0.03, 0.2, 0.55],
  [-0.08, 0.3, 0.6],
  [-0.2, 0.34, 0.68],
  [0.55, 0.5, 0.25],
]

export function buildHand(spec: { anchor: Vec3; side: 1 | -1; fingers: FingerSpec[]; arm?: number; armMaterial?: Material }): HandRig {
  const relaxed = new Float32Array(spec.fingers.length * 3)
  spec.fingers.forEach((finger, i) => {
    const [yaw, first, flex] = RELAXED[i]
    relaxed.set(tipOf(finger, yaw * spec.side, first, flex), i * 3)
  })
  return { arm: DEFAULT_ARM, armMaterial: MATERIAL.shell, ...spec, relaxed }
}

// Scratch values, so a frame allocates nothing here.
const a = rigid()
const b = rigid()
const led: [number, number, number] = [0, 0, 0]
const angles = [0, 0, 0]

const QUARTER = Math.PI / 2
const tipColor: [number, number, number] = [0, 0, 0]
/** The color of a fingertip at full brightness. */
const TIP_GLOW: Rgb = [0.45, 0.72, 1.7]

function drawFinger(sink: PartSink, frame: Rigid, finger: FingerSpec, lit: number): void {
  const { base, lengths, width } = finger
  translate(a, frame, base[0], base[1], base[2])
  rotateY(a, a, angles[0])
  for (let i = 0; i < 3; i++) {
    rotateX(a, a, i === 0 ? angles[1] : i === 1 ? angles[2] : angles[2] * END_JOINT)
    const w = width * (1 - i * 0.09)
    const length = lengths[i]
    // The joint.
    rotateZ(b, a, -QUARTER)
    sink.cylinder(b, w * 1.02, w * 0.98, 0.035, JOINT, MATERIAL.shell)
    // The bone.
    translate(b, a, 0, 0, length / 2)
    sink.box(b, w * 0.92, w * 0.8, length / 2 - w * 0.5, 0.05, SHELL, MATERIAL.shell, 0.08)
    // The plate on its back.
    translate(b, a, 0, w * 0.76, length / 2)
    sink.box(b, w * 0.62, 0.035, length / 2 - w * 0.68, 0.02, PLATE, MATERIAL.shell)
    if (i === 0) {
      led[0] = ACCENT[0] * lit
      led[1] = ACCENT[1] * lit
      led[2] = ACCENT[2] * lit
      translate(b, a, 0, w * 0.8, length / 2)
      sink.box(b, 0.022, 0.012, length * 0.2, 0.006, led, MATERIAL.light)
    }
    translate(a, a, 0, 0, length)
  }
  // The tip.
  translate(b, a, 0, -0.005, -0.09)
  // Past a brightness of 1, the fingertips light up too.
  const glow = Math.min(1, Math.max(0, lit - 1))
  tipColor[0] = TIP[0] + (TIP_GLOW[0] - TIP[0]) * glow
  tipColor[1] = TIP[1] + (TIP_GLOW[1] - TIP[1]) * glow
  tipColor[2] = TIP[2] + (TIP_GLOW[2] - TIP[2]) * glow
  sink.box(b, width * 0.72, width * 0.66, 0.15, 0.05, tipColor, MATERIAL.shell)
}

/** Half the width and half the length of the palm. */
export const PALM_HALF_WIDTH = 1.36
export const PALM_HALF_LENGTH = 1.45
const WRIST_Z = -2.04

/** Hand bones, from the wrist toward each finger, with the x of each knuckle. */
const METACARPALS = [1.06, 0.36, -0.34, -1.02]

function drawPalm(sink: PartSink, frame: Rigid, side: number): void {
  sink.box(frame, PALM_HALF_WIDTH, 0.26, PALM_HALF_LENGTH, 0.1, JOINT, MATERIAL.shell)
  // A long plate over each hand bone, so the back reads as a hand, not a block.
  for (const x of METACARPALS) {
    translate(a, frame, side * x * 0.96, 0.32, 0.42)
    sink.box(a, 0.29, 0.1, 0.9, 0.04, SHELL, MATERIAL.shell, 0.06)
    translate(a, frame, side * x * 0.96, 0.43, 0.46)
    sink.box(a, 0.17, 0.024, 0.7, 0.012, PLATE, MATERIAL.shell)
  }
  // The pads on the other side, so the palm reads as a palm: a large one, a heel and one at each finger.
  translate(a, frame, side * -0.14, -0.29, 0.14)
  sink.box(a, 1.02, 0.05, 0.62, 0.03, SHELL, MATERIAL.shell)
  translate(a, frame, side * -0.42, -0.29, -0.92)
  sink.box(a, 0.7, 0.05, 0.3, 0.03, PLATE, MATERIAL.shell)
  for (const x of METACARPALS) {
    translate(a, frame, side * x * 0.96, -0.3, 1.04)
    sink.box(a, 0.25, 0.05, 0.22, 0.03, PLATE, MATERIAL.shell)
  }
  // The block that carries the thumb.
  translate(a, frame, side * 1.14, -0.08, -0.68)
  sink.box(a, 0.38, 0.32, 0.66, 0.1, SHELL, MATERIAL.shell)
  // The joint bar behind the knuckles.
  translate(a, frame, 0, -0.04, PALM_HALF_LENGTH)
  rotateZ(a, a, -QUARTER)
  sink.cylinder(a, 0.23, 1.32, 0.03, JOINT, MATERIAL.shell)
  // The carpal plate, which narrows into the wrist.
  translate(a, frame, 0, 0.3, -0.98)
  sink.box(a, 0.86, 0.11, 0.5, 0.05, PLATE, MATERIAL.shell)
  translate(a, frame, 0, 0, -1.66)
  sink.box(a, 0.9, 0.25, 0.3, 0.07, SHELL, MATERIAL.shell)
}

/** Writes where the wrist of a hand is, three values from `offset`. */
export function writeWrist(out: Float32Array, offset: number, frame: Rigid): void {
  out[offset] = frame[1] * 0.02 + frame[2] * WRIST_Z + frame[3]
  out[offset + 1] = frame[5] * 0.02 + frame[6] * WRIST_Z + frame[7]
  out[offset + 2] = frame[9] * 0.02 + frame[10] * WRIST_Z + frame[11]
}

function drawForearm(sink: PartSink, frame: Rigid, anchor: Vec3, arm: number, material: Material, lit: number): void {
  const wrist = transformPoint(frame, 0, 0.02, WRIST_Z)
  // The wrist hub, in the hand.
  translate(a, frame, 0, 0.02, WRIST_Z)
  rotateZ(a, a, -QUARTER)
  sink.cylinder(a, 0.44, 0.8, 0.05, JOINT, MATERIAL.shell)

  aim(b, wrist, anchor)
  rotateX(a, b, QUARTER)
  translate(a, a, 0, 0.36, 0)
  sink.cylinder(a, 0.62, 0.24, 0.04, JOINT, MATERIAL.shell)
  // The ring of light at the wrist.
  led[0] = ACCENT[0] * lit
  led[1] = ACCENT[1] * lit
  led[2] = ACCENT[2] * lit
  rotateX(a, b, QUARTER)
  translate(a, a, 0, 0.62, 0)
  sink.cylinder(a, 0.64, 0.02, 0.006, led, MATERIAL.light)

  translate(a, b, 0, 0, arm + 0.7)
  sink.box(a, 0.72, 0.54, arm, 0.14, SHELL, material, -0.5)
  translate(a, b, 0, 0.54, arm * 0.94)
  sink.box(a, 0.44, 0.06, arm * 0.714, 0.03, PLATE, material, -0.4)
}

/**
 * Writes one hand to the sink. `targets` holds where each fingertip goes, in hand space.
 * `tips` receives the fingertip positions in the world, three values each.
 */
export function drawHand(
  sink: PartSink,
  hand: HandRig,
  frame: Rigid,
  targets: Float32Array,
  lit: number,
  tips: Float32Array,
  tipOffset: number,
): void {
  drawPalm(sink, frame, hand.side)
  for (let i = 0; i < hand.fingers.length; i++) {
    const finger = hand.fingers[i]
    solveFinger(finger, targets[i * 3], targets[i * 3 + 1], targets[i * 3 + 2], angles)
    drawFinger(sink, frame, finger, lit)
    tips[tipOffset + i * 3] = a[3]
    tips[tipOffset + i * 3 + 1] = a[7]
    tips[tipOffset + i * 3 + 2] = a[11]
  }
  drawForearm(sink, frame, hand.anchor, hand.arm, hand.armMaterial, lit)
}
