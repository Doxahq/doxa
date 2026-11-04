/** The curves, the poses and the shared timing of the hands and the disc. */

export type Vec = [number, number, number]

/** The radius of the disc. */
export const DISC_RADIUS = 2.3

/** The hand on the -x side is hand 0, and the hand on the +x side is hand 1. */
export type HandIndex = 0 | 1

export interface HandPose {
  /** The point of the hand that holds the center of the disc. */
  x: number
  y: number
  z: number
  bank: number
  nose: number
  /** The turn of the wrist around the disc. */
  wrist: number
  /** 0 is closed on the disc. 1 is a relaxed, open hand. */
  open: number
  /** 1 is the spin trick: the index points up, under the disc, and the other fingers make a fist. */
  point: number
  /** How far the raised fingertip stays below the disc. */
  gap: number
  /** 1 is a flat hand with straight fingers, for the back roll. */
  flat: number
  /** 1 puts the disc on the back of the hand, at `along`, instead of in its grip. */
  slide: number
  /** Where the disc rests on the back of the hand: the distance from the palm center toward the fingertips. */
  along: number
  /** 1 is a hand that stands up with its forearm below it, and with open fingers. */
  stand: number
  /** How bright the lights and the fingertips of the hand are, from 0 to 1. */
  glow: number
  /** The roll of the forearm around its length. A half turn shows the palm. */
  roll: number
  /** 1 is a raised hand that pushes: straight fingers, fanned out, with the thumb wide. */
  push: number
  /** 1 is a tense hand with its fingers wide apart, for the angry "why?!". */
  claw: number
  /** How far the fingers of that hand curl: 0 is flared and 1 is a hook. */
  clench: number
}

export interface DiscPose {
  x: number
  y: number
  z: number
  bank: number
  nose: number
  spin: number
  /** True while no hand holds it. */
  flying: boolean
  /** True in a trick, from the moment that the disc reaches the hand to the normal catch after it. */
  balancing: boolean
}

/**
 * One throw, from the -x side to the +x side. The other way round mirrors it. An x is
 * a share of the way across, a y is a share of the height of the hero, and a z is in
 * units of its depth: toward the camera is positive. A disc turns toward its low side,
 * so each bank matches the way that its path curves.
 */
export interface ThrowSpec {
  name: string
  seconds: number
  from: { y: number; z: number }
  to: { y: number; z: number }
  c1: { x: number; y: number; z: number }
  c2: { x: number; y: number; z: number }
  /** The tilt of the disc toward the camera, when it leaves and when it arrives. */
  bank: readonly [number, number]
  /** The rise of its leading edge. */
  nose: number
}

export type TrickName = "spin" | "backRoll" | "orbit" | "force"

/** The points and the times of one throw. */
export interface Leg {
  spec: ThrowSpec
  thrower: HandIndex
  catcher: HandIndex
  /** The way across: 1 is toward +x. */
  dir: 1 | -1
  restFrom: Vec
  restTo: Vec
  readyFrom: Vec
  readyTo: Vec
  wind: Vec
  release: Vec
  leave: Vec
  c1: Vec
  c2: Vec
  arrive: Vec
  come: Vec
  /** How much of its speed the disc keeps in the last part of the flight. */
  arriveSpeed: number
  absorb: Vec
  follow: Vec
  trick: TrickName | null
  released: number
  caught: number
  seconds: number
}

/** The tilt of the disc when a hand holds it, so that its face shows. */
export const HOLD_BANK = 0.2
/** The fingers at rest. They relax, and they open wide only for a catch. */
export const READY_OPEN = 0.72
/** Seconds that the catcher takes to reach for the disc. */
export const MEET_SECONDS = 0.4
/** Seconds for the arm of the catcher to give, with the disc in the hand. */
export const ABSORB_SECONDS = 0.2
export const ZERO: Vec = [0, 0, 0]

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** The speed curve of a human reach: no jump in speed or in acceleration at either end. */
export const reach = (x: number) => {
  const k = clamp01(x)
  return k * k * k * (k * (k * 6 - 15) + 10)
}
export const mix = (a: number, b: number, k: number) => a + (b - a) * k
/** A soft bump: 0 at both ends and 1 in the middle, and it starts and ends at no speed. */
export const swell = (k: number) => Math.sin(Math.PI * clamp01(k)) ** 2

/** A smooth path from (p0, v0) to (p1, v1) in `seconds`, at time `t`. */
export function hermite(p0: Vec, v0: Vec, p1: Vec, v1: Vec, seconds: number, t: number, out: Vec): void {
  const k = clamp01(t / seconds)
  const k2 = k * k
  const k3 = k2 * k
  const h00 = 2 * k3 - 3 * k2 + 1
  const h10 = k3 - 2 * k2 + k
  const h01 = -2 * k3 + 3 * k2
  const h11 = k3 - k2
  for (let i = 0; i < 3; i++) out[i] = h00 * p0[i] + h10 * seconds * v0[i] + h01 * p1[i] + h11 * seconds * v1[i]
}

/** The same path for one value. */
export function hermite1(p0: number, v0: number, p1: number, v1: number, seconds: number, t: number): number {
  const k = clamp01(t / seconds)
  const k2 = k * k
  const k3 = k2 * k
  return (2 * k3 - 3 * k2 + 1) * p0 + (k3 - 2 * k2 + k) * seconds * v0 + (-2 * k3 + 3 * k2) * p1 + (k3 - k2) * seconds * v1
}

export const putAt = (pose: { x: number; y: number; z: number }, at: Vec) => {
  pose.x = at[0]
  pose.y = at[1]
  pose.z = at[2]
}
