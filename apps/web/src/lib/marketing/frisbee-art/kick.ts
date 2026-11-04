import type { Field } from "~/lib/marketing/frisbee-art/flight"
import { clamp01, DISC_RADIUS, HOLD_BANK, hermite, mix, putAt, reach, READY_OPEN, ZERO, type DiscPose, type HandPose, type Vec } from "~/lib/marketing/frisbee-art/motion"
import { DROP_BOUNCE, DROP_GRAVITY, KICK_SHOVE, WHY_JAB_HEIGHT, WHY_JAB_SECONDS, WHY_JABS } from "~/lib/marketing/frisbee-art/settings"

/**
 * What a click does to a hand: the shock of the hit, the disc that falls, the angry
 * "why?!" at the visitor, and the hand that picks the disc up again.
 */

// ---------- The hit: a spring that throws the hand, and it shakes out. ----------

export interface Shock {
  since: number
  /** The way of the hit on the screen: x to the right and y up, with a length of 1. */
  x: number
  y: number
  /** 1 is a full hit. */
  power: number
}

const SHOCK_RATE = 24
const SHOCK_DAMP = 8
/** The hand is heavier than the arm, so it turns a moment after the arm moves, and it turns for longer. */
const TURN_RATE = 15
const TURN_DAMP = 6
const SHOCK_NOSE = 0.85
const SHOCK_ROLL = 0.5
const SHOCK_WRIST = 0.45
const SHOCK_AWAY = 0.35
const OPEN_DAMP = 10
export const SHOCK_SECONDS = 1

/** Adds the shock to the pose. The start is a jump in speed and not in place, as in a real hit. */
export function writeShock(hand: HandPose, shock: Shock, side: number): void {
  const t = shock.since
  const push = shock.power * KICK_SHOVE * Math.exp(-SHOCK_DAMP * t) * Math.sin(SHOCK_RATE * t)
  const turn = shock.power * Math.exp(-TURN_DAMP * t) * Math.sin(TURN_RATE * t)
  hand.x += shock.x * push
  hand.y += shock.y * push
  hand.z -= push * SHOCK_AWAY
  // A hit from above drops the fingers, and a hit from below throws them up.
  hand.nose -= side * shock.y * SHOCK_NOSE * turn
  hand.bank += side * shock.x * SHOCK_ROLL * turn
  hand.wrist += side * shock.x * SHOCK_WRIST * turn
  // The fingers fly open.
  hand.open = mix(hand.open, 1, shock.power * Math.exp(-OPEN_DAMP * t))
}

// ---------- The "why?!": the palm up at the visitor, in hard jabs. ----------

/** A short beat after the hit, and the time to turn to the visitor. */
const WHY_BEAT = 0.1
const WHY_TURN = 0.2
/** The last jab stays up and trembles, and the arm then drops in disgust. */
const WHY_HOLD = 0.3
const WHY_OUT = 0.34
const WHY_JABS_START = WHY_BEAT + WHY_TURN
const WHY_JABS_END = WHY_JABS_START + WHY_JABS * WHY_JAB_SECONDS

export const WHY_SECONDS = WHY_JABS_END + WHY_HOLD + WHY_OUT

/** The pose of the gesture, around the place where a hand waits for the disc. */
const WHY_RISE = 1.4
const WHY_NEAR = 2
const WHY_IN = 1.6
/** The forearm turns the palm up and toward the visitor. */
const WHY_ROLL = 2.0
const WHY_STAND = 0.6
/** The fingers point up this far between jabs, and this much more at the top of a jab. */
const WHY_NOSE = 0.1
const WHY_NOSE_JAB = 0.42
/** The share of a jab to its top: it goes up fast, and it comes back slower. */
const JAB_UP = 0.3
/** The wrist comes this share of a jab after the arm. */
const WRIST_LAG = 0.09
/** Each jab is harder than the last one. */
const FIRST_JAB = 0.72
/** The servo goes a little past the top and it snaps back. */
const SNAP = 0.1
const TREMBLE = 0.07
/** The fingers never quite straighten: a tense hand keeps its hook, even at the top of a jab. */
const WHY_FLARE = 0.15

/** The height of the arm at this count of jabs, from 0 to about 1. The last jab does not come down. */
function jabHeight(jabs: number): number {
  if (jabs < 0) return 0
  const n = Math.min(Math.floor(jabs), WHY_JABS - 1)
  const k = Math.min(1, jabs - n)
  const past = k - JAB_UP
  const snap = past > 0 ? SNAP * Math.exp(-past * 16) * Math.sin(past * 34) : 0
  const down = n === WHY_JABS - 1 ? 0 : reach(past / (1 - JAB_UP))
  return mix(FIRST_JAB, 1, n / Math.max(1, WHY_JABS - 1)) * (reach(k / JAB_UP) * (1 - down) + snap)
}

/**
 * Writes the gesture at this time after the hit, and returns how far it replaces the
 * pose of the game: 0 before it and after it, and 1 in the middle.
 */
export function writeWhy(out: HandPose, t: number, side: number, ready: Vec): number {
  const jabs = (t - WHY_JABS_START) / WHY_JAB_SECONDS
  const arm = jabHeight(jabs)
  const wrist = jabHeight(jabs - WRIST_LAG / WHY_JAB_SECONDS)
  const fury = reach((t - WHY_BEAT) / WHY_TURN) * (1 - reach((t - WHY_JABS_END - WHY_HOLD) / WHY_OUT))
  out.x = ready[0] - side * WHY_IN * arm + Math.sin(t * 61) * TREMBLE * fury
  out.y = ready[1] + WHY_RISE + WHY_JAB_HEIGHT * arm + Math.sin(t * 73) * TREMBLE * fury
  out.z = WHY_NEAR + arm
  out.bank = 0
  out.nose = -side * (WHY_NOSE + WHY_NOSE_JAB * wrist)
  out.wrist = 0
  out.roll = WHY_ROLL
  out.open = 1
  out.point = 0
  out.gap = 0
  out.flat = 0
  out.slide = 0
  out.along = 0
  out.stand = WHY_STAND
  out.glow = 0
  out.push = 0
  out.claw = 1
  // The fingers flare at the top of a jab, and they hook as the arm comes back.
  out.clench = mix(1, WHY_FLARE, clamp01(wrist * 1.15))
  return fury
}

const POSE_KEYS = ["x", "y", "z", "bank", "nose", "wrist", "open", "point", "gap", "flat", "slide", "along", "stand", "glow", "roll", "push", "claw", "clench"] as const

/** Moves `hand` toward `other`, by this share. */
export function blendPose(hand: HandPose, other: HandPose, k: number): void {
  for (const key of POSE_KEYS) hand[key] = mix(hand[key], other[key], k)
}

export function copyPose(to: HandPose, from: HandPose): void {
  for (const key of POSE_KEYS) to[key] = from[key]
}

// ---------- The fall: the disc drops, it bounces, and it rings down flat like a dropped plate. ----------

export interface LooseDisc {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  bank: number
  nose: number
  bankRate: number
  noseRate: number
  spinRate: number
  /** The seconds of the ring-down so far, or -1 before it starts. */
  ringing: number
  ringFrom: number
  ringPhase: number
  ringSeconds: number
  settled: boolean
}

/** Half the thickness of the disc, so that it lies on the floor and not in it. */
const DISC_HALF_THICK = 0.2
/** How fast a hit throws the disc away, and how far it pops up. */
const HIT_SPEED = 13
const HIT_POP = 9
const MAX_START_SPEED = 45
const HIT_SPIN = 9
/** A falling plate rocks: the air pulls it back toward flat, a little at a time. */
const ROCK_PULL = 30
const ROCK_DAMP = 0.6
const ROCK_START = 7
/** At a bounce, how much of the speed along the floor and of the rocking stays. */
const FLOOR_KEEP = 0.6
const DEPTH_KEEP = 0.4
const ROCK_KEEP = 0.6
/** A rim that strikes the floor throws the disc over the other way. */
const RIM_KICK = 0.12
const SPIN_KEEP = 0.7
/** Below this speed, the disc no longer leaves the floor. It rings down. */
const LAST_BOUNCE = 7
const RING_BASE = 0.45
const RING_PER_TILT = 1.3
const RING_RATE = 8
const RING_RATE_END = 42
const RING_SHAPE = 0.7
const SLIDE_DRAG = 6
const SPIN_DRAG = 3
/** The side of the hero where a disc at this x must stop: never under the content and never off the page. */
const FROM_CONTENT = DISC_RADIUS + 0.6
const FROM_PAGE_SIDE = DISC_RADIUS + 1.2

/** The lowest and the highest x where a disc can stop, on the side of this x. */
export function floorBand(x: number, field: Field): [number, number] {
  const s = x < 0 ? -1 : 1
  const inner = field.inner + FROM_CONTENT
  const outer = Math.max(inner, field.edge - FROM_PAGE_SIDE)
  return s > 0 ? [inner, outer] : [-outer, -inner]
}

/** About how many seconds of its speed along the floor a falling disc uses, before it stops. */
function travelSeconds(vy: number, height: number): number {
  const air = (vy + Math.sqrt(vy * vy + 2 * DROP_GRAVITY * Math.max(0, height))) / DROP_GRAVITY
  const impact = DROP_GRAVITY * air - vy
  const second = (2 * DROP_BOUNCE * impact) / DROP_GRAVITY
  return air + FLOOR_KEEP * second + FLOOR_KEEP * FLOOR_KEEP * DROP_BOUNCE * second + 1 / SLIDE_DRAG
}

/** Lets the disc go, with the speed that it has and the way of the hit. */
export function launchDisc(from: DiscPose, speed: Vec, hit: { x: number; y: number }, spinRate: number, field: Field, random: () => number): LooseDisc {
  const fast = Math.hypot(speed[0], speed[1], speed[2])
  const keep = fast > MAX_START_SPEED ? MAX_START_SPEED / fast : 1
  const vy = speed[1] * keep + hit.y * HIT_SPEED * 0.6 + HIT_POP
  const [low, high] = floorBand(from.x, field)
  const seconds = travelSeconds(vy, from.y - field.floor)
  const vx = Math.min((high - from.x) / seconds, Math.max((low - from.x) / seconds, speed[0] * keep + hit.x * HIT_SPEED))
  return {
    x: from.x,
    y: from.y,
    z: from.z,
    vx,
    vy,
    // It lands on the plane of the hero, whatever depth it starts from.
    vz: -from.z / seconds,
    bank: from.bank,
    nose: from.nose,
    // It rocks toward the camera first, so that the face of the disc shows as it falls.
    bankRate: random() * ROCK_START,
    noseRate: (random() - 0.5) * 2 * ROCK_START - hit.x * 4,
    spinRate: spinRate + (random() < 0.5 ? -1 : 1) * HIT_SPIN,
    ringing: -1,
    ringFrom: 0,
    ringPhase: 0,
    ringSeconds: 0,
    settled: false,
  }
}

const tiltOf = (bank: number, nose: number) => Math.min(Math.PI / 2, Math.hypot(bank, nose))

/** Moves the falling disc forward by a short step. */
export function stepDisc(d: LooseDisc, step: number, field: Field): void {
  if (d.settled) return
  if (d.ringing >= 0) {
    const drag = Math.exp(-SLIDE_DRAG * step)
    d.vx *= drag
    d.vz *= drag
    d.x += d.vx * step
    d.z += d.vz * step
    d.spinRate *= Math.exp(-SPIN_DRAG * step)
    d.ringing += step
    const k = clamp01(d.ringing / d.ringSeconds)
    // Like a coin that spins down: the tilt gets smaller, and the wobble gets faster and faster.
    d.ringPhase += mix(RING_RATE, RING_RATE_END, k * k) * step
    const tilt = d.ringFrom * (1 - k) ** RING_SHAPE
    d.bank = tilt * Math.sin(d.ringPhase)
    d.nose = tilt * Math.cos(d.ringPhase)
    d.y = field.floor + DISC_HALF_THICK + DISC_RADIUS * Math.sin(tilt)
    if (k >= 1) {
      d.settled = true
      d.spinRate = 0
    }
    return
  }
  d.vy -= DROP_GRAVITY * step
  d.x += d.vx * step
  d.y += d.vy * step
  d.z += d.vz * step
  d.bankRate += (-ROCK_PULL * d.bank - ROCK_DAMP * d.bankRate) * step
  d.noseRate += (-ROCK_PULL * d.nose - ROCK_DAMP * d.noseRate) * step
  d.bank += d.bankRate * step
  d.nose += d.noseRate * step
  const tilt = tiltOf(d.bank, d.nose)
  const contact = field.floor + DISC_HALF_THICK + DISC_RADIUS * Math.sin(tilt)
  if (d.y > contact || d.vy >= 0) return
  d.y = contact
  const impact = -d.vy
  d.vy = impact * DROP_BOUNCE
  d.vx *= FLOOR_KEEP
  d.vz *= DEPTH_KEEP
  d.bankRate = -d.bankRate * ROCK_KEEP - d.bank * impact * RIM_KICK
  d.noseRate = -d.noseRate * ROCK_KEEP - d.nose * impact * RIM_KICK
  d.spinRate *= SPIN_KEEP
  if (d.vy < LAST_BOUNCE) {
    d.vy = 0
    d.ringing = 0
    d.ringFrom = tilt
    d.ringPhase = Math.atan2(d.bank, d.nose)
    d.ringSeconds = RING_BASE + RING_PER_TILT * tilt
  }
}

export function writeLooseDisc(disc: DiscPose, d: LooseDisc): void {
  disc.x = d.x
  disc.y = d.y
  disc.z = d.z
  disc.bank = d.bank
  disc.nose = d.nose
  disc.flying = true
  disc.balancing = false
}

// ---------- The pick up: the fingers tip the disc up from the floor, and the arm lifts it. ----------

/** The seconds to reach down, at least and for each world unit of the way. */
const REACH_SECONDS = 0.42
const REACH_PER_UNIT = 0.009
export const GRAB_SECONDS = 0.16
export const LIFT_SECONDS = 0.46
/** How far the fingers tip the disc up, so that they can get under its rim. */
const GRAB_TILT = 0.62
/** How far above its place the open hand stops, before it closes. */
const HOVER = 1.1
/** How high the arm swings the disc on the way back up. */
const LIFT_ARC = 0.7

export const reachSeconds = (from: Vec, to: Vec) => REACH_SECONDS + REACH_PER_UNIT * Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])

/** The disc as the fingers tip it up: its far rim stays on the floor, and its rim on the side of the hand rises. */
export function writeTipped(disc: DiscPose, lying: LooseDisc, k: number, side: number, field: Field): void {
  const angle = GRAB_TILT * reach(k)
  disc.x = lying.x - side * DISC_RADIUS * (1 - Math.cos(angle))
  disc.y = field.floor + DISC_HALF_THICK + DISC_RADIUS * Math.sin(angle)
  disc.z = lying.z
  disc.bank = 0
  disc.nose = side * angle
  disc.flying = true
  disc.balancing = false
}

const at: Vec = [0, 0, 0]

/** The hand on its way down, with the fingers open. `to` is the disc when the fingers have tipped it. */
export function writeReachDown(hand: HandPose, from: Vec, to: DiscPose, k: number): void {
  hermite(from, ZERO, [to.x, to.y + HOVER, to.z], ZERO, 1, k, at)
  putAt(hand, at)
  const turned = reach(k / 0.8)
  hand.bank = mix(HOLD_BANK, to.bank, turned)
  hand.nose = to.nose * turned
  hand.wrist = 0
  hand.open = mix(READY_OPEN, 1, reach(k / 0.6))
}

/** The hand closes as it comes down on the rim. */
export function writeGrab(hand: HandPose, to: DiscPose, k: number): void {
  hand.x = to.x
  hand.y = to.y + HOVER * (1 - reach(k))
  hand.z = to.z
  hand.bank = to.bank
  hand.nose = to.nose
  hand.wrist = 0
  hand.open = 1 - reach(k)
}

/** The disc in the hand, on the way from the floor to the place where a hand holds it. */
export function writeLift(disc: DiscPose, from: DiscPose, held: Vec, k: number): void {
  hermite([from.x, from.y, from.z], ZERO, held, ZERO, 1, k, at)
  putAt(disc, at)
  disc.y += LIFT_ARC * Math.sin(Math.PI * clamp01(k))
  const turned = reach(k)
  disc.bank = mix(from.bank, HOLD_BANK, turned)
  disc.nose = from.nose * (1 - turned)
  disc.flying = false
  disc.balancing = false
}
