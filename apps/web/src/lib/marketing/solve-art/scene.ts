import { createCube, cubieCoord, type Cubie } from "~/lib/marketing/solve-art/cube"
import { invertTo, multiply, rigid, rotateX, rotateY, rotateZ, translate, type Rigid, type Vec3 } from "~/lib/marketing/solve-art/math"
import { buildHand, drawHand, MATERIAL, PALM_HALF_LENGTH, standardFingers, type HandRig, type PartSink, type Rgb } from "~/lib/marketing/solve-art/rig"
import { createTimeline, FINGERS, INDEX, THUMB, type HandIndex, type HandPose, type Pose } from "~/lib/marketing/solve-art/timeline"

/** The cube colors, from the theme: faces +x, -x, +y, -y, +z, -z. */
const FACE_COLORS: readonly Rgb[] = [
  [0.612, 0.761, 1], // ice, #9cc2ff
  [0.33, 0.37, 0.46], // slate
  [0.93, 0.93, 0.93], // text, #ededed
  [0.141, 0.325, 0.788], // deep, #2453c9
  [0.239, 0.482, 1], // accent, #3d7bff
  [0.769, 0.631, 1], // lavender, #c4a1ff
]
const BODY: Rgb = [0.035, 0.035, 0.042]
const LOGO_DOT: Rgb = [0.1, 0.1, 0.094]

const CUBIE_HALF = 0.485
const STICKER_HALF = 0.405
const STICKER_THICKNESS = 0.012
const CORE_HALF = 1
const SEED = 11

/**
 * Where each fingertip rests in the grip of the hand on the +x side, in cube space:
 * index, middle, ring, little, thumb. The fingers arch over the face toward the
 * camera, and the thumb sits on the side of the far layer, behind them. The hand on
 * the -x side mirrors them.
 */
const REST: readonly Vec3[] = [
  [1.2, 1.02, 1.74],
  [0.72, 0.3, 1.66],
  [0.78, -0.38, 1.66],
  [1, -1.02, 1.64],
  [1.66, 0.1, -0.72],
]

/** Where a fingertip touches the layer that it pushes, in the same order. */
const TOUCH: readonly Vec3[] = [
  [1.2, 1.02, 1.62],
  [0.95, 1.02, 1.62],
  [0.78, -0.38, 1.66],
  [1, -1.02, 1.62],
  [1.66, -0.2, -1],
]

/** The axis of the layer that each finger pushes, and how far the fingertip rides on it. */
const SWEEP_AXIS: readonly number[] = [1, 1, 1, 1, 2]
const SWEEP_ANGLE: readonly number[] = [-0.58, -0.48, 0, -0.42, 0.5]

/** The share of a roll that the wrist of the hand takes. The cube turns on through its fingertips. */
const CARRY_SHARE = 0.45
/** How far a fingertip drags along its face, for each radian that the wrist rocks. */
const DRAG = 1.25
/** The fingertips stay on the face, this far from its center. */
const DRAG_LIMIT = 1.28
/** How far a fingertip lifts off its face, at most. */
const LIFT = 0.26
/** Where the hand on the +x side goes when it lets go of the cube. It mirrors for the other hand. */
const AWAY: Vec3 = [1.5, -1.5, 1]

const KNUCKLES: Vec3 = [2.95, 0.5, 2.85]
const WRIST_FROM_KNUCKLES: Vec3 = [2.6, -1.9, -1.7]
const ANCHOR: Vec3 = [18, -13, -10]

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]]

/** The frame of the hand on the side `s`, in the rest of its grip. Exported for the tests. */
export function restFrame(s: 1 | -1): Rigid {
  const z = normalize([-WRIST_FROM_KNUCKLES[0] * s, -WRIST_FROM_KNUCKLES[1], -WRIST_FROM_KNUCKLES[2]])
  const knuckles: Vec3 = [KNUCKLES[0] * s, KNUCKLES[1], KNUCKLES[2]]
  const center: Vec3 = [knuckles[0] - z[0] * PALM_HALF_LENGTH, knuckles[1] - z[1] * PALM_HALF_LENGTH, knuckles[2] - z[2] * PALM_HALF_LENGTH]
  // The back of the hand faces away from the cube.
  const out = normalize(center)
  const along = out[0] * z[0] + out[1] * z[1] + out[2] * z[2]
  const y = normalize([out[0] - z[0] * along, out[1] - z[1] * along, out[2] - z[2] * along])
  const x = cross(y, z)
  return Float32Array.of(x[0], y[0], z[0], center[0], x[1], y[1], z[1], center[1], x[2], y[2], z[2], center[2])
}

/** The hand on the side `s`. On the +x side, hand-space x points down, so the index is at -x. */
export function handRig(s: 1 | -1): HandRig {
  const side = (s === 1 ? -1 : 1) as 1 | -1
  return buildHand({ anchor: [ANCHOR[0] * s, ANCHOR[1], ANCHOR[2]], side, fingers: standardFingers(side) })
}

export interface SolveScene {
  update(seconds: number): void
  /** Writes the frame to the sink, and the occluders as x, y, z, radius. */
  draw(sink: PartSink, occluders: Float32Array): void
  /** 0 to 1: the short lift in brightness when the cube is solved. */
  glow(): number
  /** The seconds that the scene has run. */
  time(): number
}

/** The side of each hand: hand 0 is on -x. */
export const SIDES: readonly [1 | -1, 1 | -1] = [-1, 1]

const quietM = rigid()
const shakenM = rigid()
const layerM = rigid()
const cubieM = rigid()
const partM = rigid()
const rotM = rigid()
const rattleM = [rigid(), rigid(), rigid()]
const toHand = rigid()
const scratchA = rigid()

/** Sets the frame that the hands and the cube share. With `shaken`, it adds the shake of the hand that holds the cube alone. */
export function rootFrame(out: Rigid, pose: Pose, shaken: boolean): Rigid {
  out.set(rigid())
  if (shaken && pose.shake > 0) {
    const swing = Math.sin(pose.shakePhase) * pose.shake
    const beat = Math.sin(pose.shakePhase * 0.5 + 0.8) * pose.shake
    translate(out, out, beat * 0.16, swing * 0.5, swing * 0.1)
    rotateZ(out, out, swing * 0.2)
    rotateX(out, out, beat * 0.12)
  }
  rotateY(out, out, pose.yaw)
  rotateX(out, out, pose.pitch)
  return rotateZ(out, out, pose.roll)
}

/** Sets the frame of a hand from the frame that it shares with the cube. Exported for the tests. */
export function handFrame(out: Rigid, root: Rigid, hand: HandPose, s: 1 | -1, rest: Rigid): Rigid {
  rotateX(out, root, hand.rock + hand.carry * CARRY_SHARE)
  translate(out, out, AWAY[0] * s * hand.away, AWAY[1] * hand.away, AWAY[2] * hand.away)
  return multiply(out, out, rest)
}

/** How far a corner of a turning layer stands past the plane of its face, at this angle. */
const cornerBulge = (angle: number) => 1.5 * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)) - 1)

/** True when a fingertip at this height is on the layer that is turning, so that the layer pushes it out. */
function onTurningLayer(pose: Pose, f: number, s: 1 | -1, height: number): boolean {
  const { turn } = pose
  if (!turn || turn.coord === 0) return false
  if (turn.axis === 0) return turn.coord === s
  if (turn.axis === 1) return height * turn.coord > 0.3
  return REST[f][2] * turn.coord > 0
}

/**
 * Writes where a fingertip goes, in cube space. As a wrist rocks, the fingertips drag
 * along their faces. In a carried roll, they stay on the cube. A fingertip on a turning
 * layer rides out over the corners. The index stays free for its flicks, so a wrist
 * can move and then flick in one motion, as in R U R' U'.
 */
function fingerTarget(out: number[], pose: Pose, hand: HandPose, f: number, s: 1 | -1): void {
  const rest = REST[f]
  const front = f === THUMB ? -1 : 1
  const drag = f === INDEX ? 0.7 : 1
  const dragged = rest[1] - front * Math.sin(hand.rock) * DRAG * drag
  const py = Math.min(DRAG_LIMIT, Math.max(-DRAG_LIMIT, dragged))
  // In a roll, the fingertips turn with the wrist, and they ride over the corners of the cube.
  const wrist = hand.carry * CARRY_SHARE
  const rolled = pose.turn?.coord === 0 ? pose.turn.angle : 0
  const riding = (onTurningLayer(pose, f, s, py) ? cornerBulge(pose.turn?.angle ?? 0) : 0) + (hand.carry !== 0 ? cornerBulge(wrist - rolled) * 1.1 : 0)
  const lift = hand.lift[f] * LIFT + riding
  // A thumb rests on a side face, so it lifts sideways.
  const pz = f === THUMB ? rest[2] : rest[2] + lift
  const c = Math.cos(wrist)
  const n = Math.sin(wrist)
  let x = (rest[0] + (f === THUMB ? lift : 0)) * s
  let y = py * c - pz * n
  let z = py * n + pz * c
  const touch = hand.touch[f]
  if (touch > 0) {
    const [tx, ty, tz] = TOUCH[f]
    const sweep = hand.sweep[f] * SWEEP_ANGLE[f] * s
    const sc = Math.cos(sweep)
    const sn = Math.sin(sweep)
    const px = tx * s
    // Fingertips ride on the layer around y, and a thumb rides on it around z. The layer
    // spins on past the fingertip, and its corners push the fingertip out.
    const aroundY = SWEEP_AXIS[f] === 1
    const a = aroundY ? px * sc + tz * sn : px * sc - ty * sn
    const b = aroundY ? tz * sc - px * sn : px * sn + ty * sc
    const { turn } = pose
    const out = turn && turn.axis === SWEEP_AXIS[f] && turn.coord !== 0 ? cornerBulge(turn.angle - sweep) : 0
    const grow = 1 + out / Math.hypot(a, b)
    const cx = a * grow
    const cy = aroundY ? ty : b * grow
    const cz = aroundY ? b * grow : tz
    x += (cx - x) * touch
    y += (cy - y) * touch
    z += (cz - z) * touch
  }
  out[0] = x
  out[1] = y
  out[2] = z
}

const point = [0, 0, 0]

/** Fills `targets` with where each fingertip of a hand goes, in hand space. Exported for the tests. */
export function handTargets(targets: Float32Array, rig: HandRig, root: Rigid, frame: Rigid, pose: Pose, h: HandIndex): void {
  const hand = pose.hands[h]
  const s = SIDES[h]
  invertTo(toHand, frame)
  multiply(scratchA, toHand, root)
  const m = scratchA
  for (let f = 0; f < FINGERS; f++) {
    fingerTarget(point, pose, hand, f, s)
    const hx = m[0] * point[0] + m[1] * point[1] + m[2] * point[2] + m[3]
    const hy = m[4] * point[0] + m[5] * point[1] + m[6] * point[2] + m[7]
    const hz = m[8] * point[0] + m[9] * point[1] + m[10] * point[2] + m[11]
    const open = hand.open
    targets[f * 3] = hx + (rig.relaxed[f * 3] - hx) * open
    targets[f * 3 + 1] = hy + (rig.relaxed[f * 3 + 1] - hy) * open
    targets[f * 3 + 2] = hz + (rig.relaxed[f * 3 + 2] - hz) * open
  }
}

function drawCube(sink: PartSink, cube: readonly Cubie[], pose: Pose, group: Rigid): void {
  const { turn } = pose
  if (turn) {
    if (turn.axis === 0) rotateX(layerM, group, turn.angle)
    else if (turn.axis === 1) rotateY(layerM, group, turn.angle)
    else rotateZ(layerM, group, turn.angle)
  }
  if (pose.shake > 0) {
    // The layers of a loose cube rattle in a shake.
    for (let i = 0; i < 3; i++) rotateY(rattleM[i], group, Math.sin(pose.shakePhase * (1.1 + i * 0.27) + i * 2.1) * pose.shake * 0.3)
  }

  // A dark core fills the gaps that show in a turn. It stays small enough that its
  // corners never come through the side of a layer at 45 degrees.
  sink.box(turn && turn.coord === 0 ? layerM : group, CORE_HALF, CORE_HALF, CORE_HALF, 0.02, BODY, MATERIAL.core)

  for (const cubie of cube) {
    const { rotation: r, home } = cubie
    rotM[0] = r[0]
    rotM[1] = r[1]
    rotM[2] = r[2]
    rotM[4] = r[3]
    rotM[5] = r[4]
    rotM[6] = r[5]
    rotM[8] = r[6]
    rotM[9] = r[7]
    rotM[10] = r[8]
    const moving = turn && (turn.coord === 0 || cubieCoord(cubie, turn.axis) === turn.coord)
    const parent = moving ? layerM : pose.shake > 0 ? rattleM[cubieCoord(cubie, 1) + 1] : group
    multiply(cubieM, parent, rotM)
    translate(cubieM, cubieM, home[0], home[1], home[2])
    sink.box(cubieM, CUBIE_HALF, CUBIE_HALF, CUBIE_HALF, 0.06, BODY, MATERIAL.core)
    for (let axis = 0; axis < 3; axis++) {
      const sign = home[axis]
      if (sign === 0) continue
      const offset = sign * (CUBIE_HALF + STICKER_THICKNESS * 0.5)
      translate(partM, cubieM, axis === 0 ? offset : 0, axis === 1 ? offset : 0, axis === 2 ? offset : 0)
      sink.box(
        partM,
        axis === 0 ? STICKER_THICKNESS : STICKER_HALF,
        axis === 1 ? STICKER_THICKNESS : STICKER_HALF,
        axis === 2 ? STICKER_THICKNESS : STICKER_HALF,
        0.008,
        FACE_COLORS[axis * 2 + (sign > 0 ? 0 : 1)],
        MATERIAL.sticker,
      )
      // The white center carries the dot of the Doxa logo, as a real cube carries its maker's mark.
      if (axis === 1 && sign > 0 && home[0] === 0 && home[2] === 0) {
        translate(partM, cubieM, 0, offset + STICKER_THICKNESS, 0)
        sink.cylinder(partM, 0.17, 0.006, 0.004, LOGO_DOT, MATERIAL.core)
      }
    }
  }
}

const frames = [rigid(), rigid()]
const targetsOf = [new Float32Array(FINGERS * 3), new Float32Array(FINGERS * 3)]
const tips = new Float32Array(30)

function writeOccluders(out: Float32Array): void {
  for (let h = 0; h < 2; h++) {
    out[h * 4] = frames[h][3]
    out[h * 4 + 1] = frames[h][7]
    out[h * 4 + 2] = frames[h][11]
    out[h * 4 + 3] = 3.6
  }
  for (let i = 0; i < 10; i++) {
    out[8 + i * 4] = tips[i * 3]
    out[9 + i * 4] = tips[i * 3 + 1]
    out[10 + i * 4] = tips[i * 3 + 2]
    out[11 + i * 4] = 0.72
  }
}

/** The whole scene, from the first frame of a scrambled cube in both hands. */
export function createSolveScene(): SolveScene {
  const cube = createCube()
  const rigs = [handRig(-1), handRig(1)]
  const rests = [restFrame(-1), restFrame(1)]
  const timeline = createTimeline(cube, { seed: SEED })
  let seconds = 0

  return {
    update(dt) {
      seconds += dt
      timeline.advance(dt)
    },
    draw(sink, occluders) {
      const { pose } = timeline
      rootFrame(quietM, pose, false)
      rootFrame(shakenM, pose, true)
      drawCube(sink, cube, pose, shakenM)
      for (const h of [0, 1] as HandIndex[]) {
        const hand = pose.hands[h]
        const s = SIDES[h]
        // Hand 1 holds the cube in a shake. Hand 0 has let go, so the shake does not reach it.
        const root = h === 1 ? shakenM : quietM
        handFrame(frames[h], root, hand, s, rests[h])
        handTargets(targetsOf[h], rigs[h], root, frames[h], pose, h)
        drawHand(sink, rigs[h], frames[h], targetsOf[h], 0.3 + 0.7 * (1 - hand.open), tips, h * 15)
      }
      writeOccluders(occluders)
    },
    glow: () => timeline.pose.glow,
    time: () => seconds,
  }
}
