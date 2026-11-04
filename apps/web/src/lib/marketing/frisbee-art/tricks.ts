import { BACK_ROLL_SECONDS, BACK_TOSS_HEIGHT, FORCE_HOLD_SECONDS, ORBIT_LAPS, ORBIT_SECONDS, TRICK_SPIN_SECONDS } from "~/lib/marketing/frisbee-art/settings"
import {
  ABSORB_SECONDS,
  clamp01,
  HOLD_BANK,
  hermite,
  hermite1,
  MEET_SECONDS,
  mix,
  putAt,
  reach,
  READY_OPEN,
  swell,
  ZERO,
  type DiscPose,
  type HandPose,
  type Leg,
  type TrickName,
  type Vec,
} from "~/lib/marketing/frisbee-art/motion"

/**
 * A catch that is more than a catch. Each trick writes the disc from the moment that
 * it reaches the hand, and the catching hand for the whole throw. It must end with
 * the disc at `leg.restTo` and the hand closed on it, so that the next throw starts
 * from the same place as after a normal catch. To add a trick, add an entry to `TRICKS`.
 */
export interface Trick {
  /** The seconds from the moment that the disc reaches the hand to the end of the throw. */
  catchSeconds: number
  /** The speed of the disc as it arrives, in world units a second, if the trick needs a soft landing. */
  arriveUnitsPerSecond?: number
  writeDisc(disc: DiscPose, leg: Leg, on: number): void
  writeHand(hand: HandPose, disc: DiscPose, leg: Leg, t: number, side: number): void
  /** The share of the full spin that the disc keeps, at this time after it reaches the hand. */
  spinShare(on: number): number
}

const at: Vec = [0, 0, 0]

/** The catcher before it moves for the disc. */
function holdReady(hand: HandPose, leg: Leg): void {
  putAt(hand, leg.readyTo)
  hand.bank = HOLD_BANK
  hand.nose = 0
  hand.wrist = 0
  hand.open = READY_OPEN
}

// ---------- The finger spin: the disc spins on the raised index, like a basketball. ----------

const SPIN_RISE_SECONDS = 0.5
const SPIN_POP_SECONDS = 0.62
const SPIN_POP_HEIGHT = 1.4
/** How far above the place of rest the hand holds the spinning disc. */
const SPIN_LIFT = 2.4
/** The tilt of a disc that spins on a fingertip, so that its face shows, and how fast it wobbles. */
const SPIN_BANK = 0.16
const SPIN_WOBBLE_RATE = 7
const SPIN_HAND_BANK = 0.1
/** How far the fingertip stays under the disc until the last moment, so that the rim passes over it. */
const SPIN_TIP_GAP = 0.5

const spinSeconds = ABSORB_SECONDS + SPIN_RISE_SECONDS + TRICK_SPIN_SECONDS + SPIN_POP_SECONDS
const spinPlace = (leg: Leg): Vec => [leg.restTo[0], leg.restTo[1] + SPIN_LIFT, 1]

const fingerSpin: Trick = {
  catchSeconds: spinSeconds,
  writeDisc(disc, leg, on) {
    const place = spinPlace(leg)
    const lifted = ABSORB_SECONDS + SPIN_RISE_SECONDS
    const popped = lifted + TRICK_SPIN_SECONDS
    if (on < ABSORB_SECONDS) {
      hermite(leg.arrive, leg.come, leg.absorb, ZERO, ABSORB_SECONDS, on, at)
    } else if (on < lifted) {
      hermite(leg.absorb, ZERO, place, ZERO, SPIN_RISE_SECONDS, on - ABSORB_SECONDS, at)
    } else if (on < popped) {
      // The hand keeps the disc balanced with small moves.
      const held = on - lifted
      const ease = swell(held / TRICK_SPIN_SECONDS)
      at[0] = place[0] + Math.sin(held * 3.4) * 0.14 * ease
      at[1] = place[1] + Math.sin(held * 6.9) * 0.2 * ease
      at[2] = place[2] + Math.cos(held * 2.3 - Math.PI / 2) * 0.1 * ease
    } else {
      hermite(place, ZERO, leg.restTo, ZERO, SPIN_POP_SECONDS, on - popped, at)
      at[1] += SPIN_POP_HEIGHT * swell((on - popped) / SPIN_POP_SECONDS)
    }
    putAt(disc, at)
    // A disc on a fingertip stays nearly flat. It wobbles as it lands, it steadies, and it
    // wobbles more as it slows.
    const flat = reach(on / 0.35)
    const off = reach((on - popped) / SPIN_POP_SECONDS)
    const size = 0.13 * Math.exp(-on * 2.2) + 0.015 + 0.05 * reach(on / popped)
    const tilt = size * reach(on / 0.2) * (1 - off)
    disc.bank = mix(mix(leg.spec.bank[1], SPIN_BANK, flat), HOLD_BANK, off) + tilt * Math.sin(on * SPIN_WOBBLE_RATE)
    disc.nose = leg.dir * leg.spec.nose * (1 - flat) + tilt * Math.cos(on * SPIN_WOBBLE_RATE)
  },
  writeHand(hand, disc, leg, t, side) {
    const { caught, seconds } = leg
    const meet = caught - MEET_SECONDS
    const upright = -side * (Math.PI / 2)
    const popped = seconds - SPIN_POP_SECONDS
    if (t < meet) return holdReady(hand, leg)
    hand.wrist = 0
    if (t < caught) {
      hermite(leg.readyTo, ZERO, leg.arrive, leg.come, MEET_SECONDS, t - meet, at)
      putAt(hand, at)
      const k = reach((t - meet) / MEET_SECONDS)
      hand.nose = mix(0, upright, k)
      hand.bank = mix(HOLD_BANK, SPIN_HAND_BANK, k)
      hand.point = reach((t - meet) / (MEET_SECONDS * 0.8))
      hand.gap = SPIN_TIP_GAP * (1 - reach((t - (caught - 0.12)) / 0.12))
      hand.open = mix(READY_OPEN, 1, k)
    } else if (t < popped) {
      putAt(hand, [disc.x, disc.y, disc.z])
      // The hand answers the wobble of the disc with small corrections.
      const on = t - caught
      const correct = swell(on / (popped - caught))
      hand.nose = upright + Math.sin(on * 3.4) * 0.07 * correct
      hand.bank = SPIN_HAND_BANK + Math.cos(on * 2.9 - Math.PI / 2) * 0.05 * correct
      hand.point = 1
      hand.open = 1
    } else {
      // The hand pops the disc up, it turns back under the falling disc, and it closes on the rim.
      const k = (t - popped) / SPIN_POP_SECONDS
      hand.x = disc.x
      hand.y = disc.y - SPIN_POP_HEIGHT * swell(k)
      hand.z = disc.z
      hand.nose = mix(upright, 0, reach(k / 0.86))
      hand.bank = mix(SPIN_HAND_BANK, disc.bank, reach(k))
      hand.point = 1 - reach(k / 0.5)
      hand.open = 1 - reach((k - 0.74) / 0.26)
    }
  },
  spinShare(on) {
    // The disc goes on spinning on the fingertip. It slows, and the catch stops it.
    const popped = spinSeconds - SPIN_POP_SECONDS
    return mix(0.72, 0.5, clamp01(on / popped)) * (1 - reach((on - popped - SPIN_POP_SECONDS * 0.5) / (SPIN_POP_SECONDS * 0.5)))
  },
}

// ---------- The back roll: the disc lands on the fingers, and it slides to the wrist. ----------

/** Where the disc rests on the back of the hand, from the palm center: on the fingers, and at the wrist. */
export const BACK_ON_FINGERS = 3.9
export const BACK_AT_WRIST = -2.1
/** The hand with its back up. It leans toward the camera, so that the back of the hand and the face of the disc show. */
const BACK_BANK = -2.1
const BACK_NOSE = 0.33
/** The tilt that keeps the disc flat on the back of the hand. */
const BACK_DISC_BANK = 0.335
/** How far the arm gives, in the way that the disc slides. */
const BACK_GIVE = 1.3
/** The way that the disc slides, on the +x side: toward the wrist, a little up and away from the camera. */
const BACK_SLIDE: Vec = [0.953, 0.1, -0.265]
/** The disc floats in softly, so that it can land on the fingers and still have a long way to slide. */
const BACK_ARRIVE_SPEED = 19
/** How far the hand stays under the disc until the last moment. */
const BACK_LAND_GAP = 0.7
/** Seconds and distances of the toss: a small dip, a flick of the wrist, the flight up and down, and the settling. */
const DIP_SECONDS = 0.16
const DIP_DEPTH = 0.5
const FLICK_SECONDS = 0.1
const FLICK_RISE = 2.2
const FLICK_WRIST = 0.5
const AIR_SECONDS = 0.72
const LAND_SECONDS = 0.32
/** How far above the place of rest the hand catches the disc as it falls. */
const LAND_ABOVE = 1
/** The top of a toss is at least this far above the place of the catch. */
const TOSS_ABOVE_CATCH = 3

const backSeconds = BACK_ROLL_SECONDS + DIP_SECONDS + FLICK_SECONDS + AIR_SECONDS + LAND_SECONDS

interface Toss {
  rollEnd: Vec
  dipAt: Vec
  flickAt: Vec
  landAt: Vec
  /** The speed as the disc leaves the hand, and as it comes down to it. */
  up: Vec
  down: Vec
  gravity: number
}

/** The points of a back roll. Exported for the tests. */
export function backRollPoints(leg: Leg): Toss {
  const reachOut = BACK_ON_FINGERS - BACK_AT_WRIST + BACK_GIVE
  const s = leg.dir
  const rollEnd: Vec = [leg.arrive[0] + s * BACK_SLIDE[0] * reachOut, leg.arrive[1] + BACK_SLIDE[1] * reachOut, leg.arrive[2] + BACK_SLIDE[2] * reachOut]
  const dipAt: Vec = [rollEnd[0], rollEnd[1] - DIP_DEPTH, rollEnd[2]]
  const flickAt: Vec = [rollEnd[0], dipAt[1] + FLICK_RISE, rollEnd[2]]
  const landAt: Vec = [leg.restTo[0], leg.restTo[1] + LAND_ABOVE, leg.restTo[2]]
  // The disc rises by the toss height above the place where it leaves the hand, and it falls to the place of the catch.
  // A throw that arrives low needs a higher toss, or the disc cannot reach that place.
  const H = Math.max(BACK_TOSS_HEIGHT, landAt[1] - flickAt[1] + TOSS_ABOVE_CATCH)
  const T = AIR_SECONDS
  const drop = flickAt[1] - landAt[1]
  const rise = (4 * H) / T
  const v = (rise + Math.sqrt(Math.max(0, rise * rise + (16 * H * drop) / (T * T)))) / 2
  const gravity = (v * v) / (2 * H)
  const vx = (landAt[0] - flickAt[0]) / T
  const vz = (landAt[2] - flickAt[2]) / T
  return { rollEnd, dipAt, flickAt, landAt, up: [vx, v, vz], down: [vx, v - gravity * T, vz], gravity }
}

const backRoll: Trick = {
  catchSeconds: backSeconds,
  arriveUnitsPerSecond: BACK_ARRIVE_SPEED,
  writeDisc(disc, leg, on) {
    const toss = backRollPoints(leg)
    const dipped = BACK_ROLL_SECONDS + DIP_SECONDS
    const flicked = dipped + FLICK_SECONDS
    const landed = flicked + AIR_SECONDS
    if (on < BACK_ROLL_SECONDS) {
      hermite(leg.arrive, leg.come, toss.rollEnd, ZERO, BACK_ROLL_SECONDS, on, at)
    } else if (on < dipped) {
      hermite(toss.rollEnd, ZERO, toss.dipAt, ZERO, DIP_SECONDS, on - BACK_ROLL_SECONDS, at)
    } else if (on < flicked) {
      hermite(toss.dipAt, ZERO, toss.flickAt, toss.up, FLICK_SECONDS, on - dipped, at)
    } else if (on < landed) {
      const air = on - flicked
      at[0] = toss.flickAt[0] + toss.up[0] * air
      at[1] = toss.flickAt[1] + toss.up[1] * air - (toss.gravity * air * air) / 2
      at[2] = toss.flickAt[2] + toss.up[2] * air
    } else {
      hermite(toss.landAt, toss.down, leg.restTo, ZERO, LAND_SECONDS, on - landed, at)
    }
    putAt(disc, at)
    const on1 = reach(on / 0.22)
    // A small wobble as the disc rides over the fingers and the knuckles. It steadies at the wrist.
    const ride = 0.05 * reach(on / 0.1) * (1 - reach(on / BACK_ROLL_SECONDS))
    const off = reach((on - flicked) / (AIR_SECONDS * 0.8))
    disc.bank = mix(mix(leg.spec.bank[1], BACK_DISC_BANK, on1), HOLD_BANK, off) + ride * Math.sin(on * 15)
    disc.nose = leg.dir * leg.spec.nose * (1 - on1)
  },
  writeHand(hand, disc, leg, t, side) {
    const { caught } = leg
    const meet = caught - MEET_SECONDS
    if (t < meet) return holdReady(hand, leg)
    hand.wrist = 0
    const nose = side * BACK_NOSE
    if (t < caught) {
      // The arm turns over as it reaches out: palm down, with straight fingers.
      hermite(leg.readyTo, ZERO, leg.arrive, leg.come, MEET_SECONDS, t - meet, at)
      putAt(hand, at)
      const k = reach((t - meet) / MEET_SECONDS)
      hand.y -= BACK_LAND_GAP * (1 - reach((t - (caught - 0.14)) / 0.14))
      hand.bank = mix(HOLD_BANK, BACK_BANK, k)
      hand.nose = mix(0, nose, k)
      hand.flat = k
      hand.slide = k
      hand.along = BACK_ON_FINGERS
      hand.open = mix(READY_OPEN, 1, k)
      return
    }
    const on = t - caught
    const toss = backRollPoints(leg)
    const dipped = BACK_ROLL_SECONDS + DIP_SECONDS
    const flicked = dipped + FLICK_SECONDS
    const landed = flicked + AIR_SECONDS
    hand.open = 1
    if (on < flicked) {
      putAt(hand, [disc.x, disc.y, disc.z])
      const length = Math.hypot(toss.rollEnd[0] - leg.arrive[0], toss.rollEnd[1] - leg.arrive[1], toss.rollEnd[2] - leg.arrive[2])
      const speed = Math.hypot(leg.come[0], leg.come[1], leg.come[2]) / length
      const moved = hermite1(0, speed, 1, 0, BACK_ROLL_SECONDS, on)
      hand.along = mix(BACK_ON_FINGERS, BACK_AT_WRIST, moved)
      hand.bank = BACK_BANK
      // The wrist flicks up with the toss.
      hand.nose = nose + side * FLICK_WRIST * reach((on - dipped) / FLICK_SECONDS)
      hand.flat = 1
      hand.slide = 1
      return
    }
    if (on < landed) {
      // The arm rolls back under the disc while it is in the air, and it reaches up for it.
      const k = (on - flicked) / AIR_SECONDS
      const slow: Vec = [toss.up[0], toss.up[1] * 0.3, toss.up[2]]
      hermite(toss.flickAt, slow, toss.landAt, toss.down, AIR_SECONDS, on - flicked, at)
      putAt(hand, at)
      const back = reach(k / 0.78)
      hand.bank = mix(BACK_BANK, HOLD_BANK, back)
      hand.nose = mix(nose + side * FLICK_WRIST, 0, back)
      hand.flat = 1 - reach(k / 0.6)
      hand.slide = 1 - reach(k / 0.6)
      hand.along = BACK_AT_WRIST
      hand.open = 1 - reach((k - 0.92) / 0.08) * 0.1
      return
    }
    putAt(hand, [disc.x, disc.y, disc.z])
    hand.bank = disc.bank
    hand.nose = disc.nose
    hand.open = 0.9 * (1 - reach((on - landed) / 0.09))
  },
  spinShare(on) {
    // The hand brakes the spin a little, and the flick spins the disc up again. The catch stops it.
    const landed = backSeconds - LAND_SECONDS
    return mix(0.72, 0.56, clamp01(on / BACK_ROLL_SECONDS)) * (1 - reach((on - landed) / 0.12))
  },
}

// ---------- The magnetic orbit: the disc circles the open hand with no touch, and the hand snatches it. ----------

/** The size of the ring, in world units: across the screen, in depth, and how far its near side is below its far side. */
const ORBIT_RADIUS = 5.2
const ORBIT_DEPTH = 8.8
const ORBIT_TILT = 1.6
/** The ring tightens in the last part of the orbit, to this share of its size. */
const ORBIT_TIGHT = 0.62
const ORBIT_TIGHTEN_FROM = 0.7
/** The ring is around the fingers: its center is this far below the point of the hand that holds a disc. */
const ORBIT_BELOW_GRIP = 1.4
/** A standing palm is this far from the point that holds a disc, toward the content. This centers it in the ring. */
export const ORBIT_PALM_SHIFT = 1.05
export const ORBIT_ENTRY_SECONDS = 0.32
const ORBIT_SNATCH_SECONDS = 0.24
const ORBIT_SETTLE_SECONDS = 0.36
const ORBIT_ARRIVE_SPEED = 26
/** The speed around the ring at the start, in radians a second. It climbs from there. */
const ORBIT_START_RATE = 3.4
/** The disc starts at the near side of the ring. Three quarters of a lap brings it to the inner side, near the grip. */
export const ORBIT_ANGLE = Math.PI * 2 * ORBIT_LAPS + Math.PI * 1.5
const ORBIT_END_RATE = (2 * ORBIT_ANGLE) / ORBIT_SECONDS - ORBIT_START_RATE
const ORBIT_BANK = 0.3
const ORBIT_HAND_BANK = 0.12

const orbitSeconds = ORBIT_ENTRY_SECONDS + ORBIT_SECONDS + ORBIT_SNATCH_SECONDS + ORBIT_SETTLE_SECONDS

/** The angle on the ring, at this time of the orbit. It runs the way that takes the disc on, past the near side. */
const orbitAngle = (dir: number, time: number) =>
  Math.PI / 2 - dir * (ORBIT_START_RATE * time + ((ORBIT_END_RATE - ORBIT_START_RATE) * time * time) / (2 * ORBIT_SECONDS))

/** The center of the ring, and the point of the hand in the middle of it. Exported for the tests. */
export function orbitCenter(leg: Leg): Vec {
  return [leg.restTo[0] + leg.dir * 1.2, leg.restTo[1] + 2.2, 0]
}

function orbitPoint(out: Vec, leg: Leg, time: number): void {
  const center = orbitCenter(leg)
  const angle = orbitAngle(leg.dir, time)
  const size = mix(1, ORBIT_TIGHT, reach((time / ORBIT_SECONDS - ORBIT_TIGHTEN_FROM) / (1 - ORBIT_TIGHTEN_FROM)))
  out[0] = center[0] + ORBIT_RADIUS * size * Math.cos(angle)
  out[1] = center[1] - ORBIT_TILT * size * Math.sin(angle)
  out[2] = center[2] + ORBIT_DEPTH * size * Math.sin(angle)
}

const a0: Vec = [0, 0, 0]
const a1: Vec = [0, 0, 0]

/** The point on the ring and the speed there. */
function orbitMotion(leg: Leg, time: number): { point: Vec; speed: Vec } {
  const step = 0.002
  orbitPoint(a0, leg, time - step)
  orbitPoint(a1, leg, time + step)
  const point: Vec = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2, (a0[2] + a1[2]) / 2]
  return { point, speed: [(a1[0] - a0[0]) / (2 * step), (a1[1] - a0[1]) / (2 * step), (a1[2] - a0[2]) / (2 * step)] }
}

/** The place where the hand snatches the disc, and the speed of the disc there: the arm gives as it lands. */
const snatchPoint = (leg: Leg): Vec => [leg.restTo[0] - leg.dir * 0.6, leg.restTo[1] + 0.5, 1.2]
const snatchSpeed = (leg: Leg): Vec => [leg.dir * 5, -2.5, -3]

const magneticOrbit: Trick = {
  catchSeconds: orbitSeconds,
  arriveUnitsPerSecond: ORBIT_ARRIVE_SPEED,
  writeDisc(disc, leg, on) {
    const orbiting = on - ORBIT_ENTRY_SECONDS
    const snatching = orbiting - ORBIT_SECONDS
    const settling = snatching - ORBIT_SNATCH_SECONDS
    if (orbiting < 0) {
      const { point, speed } = orbitMotion(leg, 0)
      hermite(leg.arrive, leg.come, point, speed, ORBIT_ENTRY_SECONDS, on, at)
    } else if (snatching < 0) {
      orbitPoint(at, leg, orbiting)
    } else if (settling < 0) {
      const { point, speed } = orbitMotion(leg, ORBIT_SECONDS)
      hermite(point, speed, snatchPoint(leg), snatchSpeed(leg), ORBIT_SNATCH_SECONDS, snatching, at)
    } else {
      hermite(snatchPoint(leg), snatchSpeed(leg), leg.restTo, ZERO, ORBIT_SETTLE_SECONDS, settling, at)
    }
    putAt(disc, at)
    // The disc lies along the ring, and it leans into the curve as it goes around.
    const angle = orbitAngle(leg.dir, clamp01(orbiting / ORBIT_SECONDS) * ORBIT_SECONDS)
    const into = reach(on / ORBIT_ENTRY_SECONDS)
    const out = reach(snatching / (ORBIT_SNATCH_SECONDS + ORBIT_SETTLE_SECONDS))
    const lean = 0.1 * into * (1 - reach(snatching / ORBIT_SNATCH_SECONDS))
    disc.bank = mix(mix(leg.spec.bank[1], ORBIT_BANK, into), HOLD_BANK, out) + lean * Math.sin(angle)
    disc.nose = leg.dir * leg.spec.nose * (1 - into) + lean * Math.cos(angle)
  },
  writeHand(hand, disc, leg, t, side) {
    const { caught } = leg
    const meet = caught - MEET_SECONDS
    if (t < meet) return holdReady(hand, leg)
    hand.wrist = 0
    const upright = -side * (Math.PI / 2)
    const center = orbitCenter(leg)
    const place: Vec = [center[0] + leg.dir * ORBIT_PALM_SHIFT, center[1] + ORBIT_BELOW_GRIP, center[2]]
    const on = t - caught
    const orbiting = on - ORBIT_ENTRY_SECONDS
    const snatching = orbiting - ORBIT_SECONDS
    if (orbiting < 0) {
      // The hand stands up with its fingers open, in the place that the ring goes around.
      const seconds = MEET_SECONDS + ORBIT_ENTRY_SECONDS
      hermite(leg.readyTo, ZERO, place, ZERO, seconds, t - meet, at)
      putAt(hand, at)
      const k = reach((t - meet) / seconds)
      hand.nose = mix(0, upright, k)
      hand.bank = mix(HOLD_BANK, ORBIT_HAND_BANK, k)
      hand.open = mix(READY_OPEN, 1, k)
      hand.stand = k
    } else if (snatching < 0) {
      // The hand leans a little toward the disc as it comes past, and its lights grow with the speed.
      const angle = orbitAngle(leg.dir, orbiting)
      const ease = swell(orbiting / ORBIT_SECONDS)
      hand.x = place[0] + Math.cos(angle) * 0.3 * ease
      hand.y = place[1]
      hand.z = place[2] + Math.sin(angle) * 0.3 * ease
      hand.nose = upright + Math.cos(angle) * 0.07 * ease
      hand.bank = ORBIT_HAND_BANK + Math.sin(angle) * 0.07 * ease
      hand.open = 1
      hand.stand = 1
      hand.glow = reach(orbiting / ORBIT_SECONDS)
    } else if (snatching < ORBIT_SNATCH_SECONDS) {
      // The wrist snaps over, and the hand grabs the disc out of the air.
      const k = snatching / ORBIT_SNATCH_SECONDS
      hermite(place, ZERO, snatchPoint(leg), snatchSpeed(leg), ORBIT_SNATCH_SECONDS, snatching, at)
      putAt(hand, at)
      const turn = reach(k)
      hand.nose = mix(upright, disc.nose, turn)
      hand.bank = mix(ORBIT_HAND_BANK, disc.bank, turn)
      hand.stand = 1 - turn
      hand.glow = 1 - turn
      hand.open = 1 - 0.85 * reach((k - 0.68) / 0.32)
    } else {
      putAt(hand, [disc.x, disc.y, disc.z])
      hand.nose = disc.nose
      hand.bank = disc.bank
      hand.open = 0.15 * (1 - reach((snatching - ORBIT_SNATCH_SECONDS) / 0.1))
    }
  },
  spinShare(on) {
    // The disc spins up with its speed around the ring, and the catch stops it.
    const snatched = ORBIT_ENTRY_SECONDS + ORBIT_SECONDS + ORBIT_SNATCH_SECONDS
    return mix(0.72, 1.05, reach(on / (ORBIT_ENTRY_SECONDS + ORBIT_SECONDS))) * (1 - reach((on - snatched + 0.04) / 0.12))
  },
}

// ---------- The Force: the raised palm stops the disc in the air, and it floats there. ----------

/** Seconds for the hand to rise, for the disc to stop in the air, and for the hand to take it. */
const FORCE_RAISE_SECONDS = 0.42
const FORCE_STOP_SECONDS = 0.28
const FORCE_TAKE_SECONDS = 0.62
/** The disc comes in at this speed, in world units a second, and it stops this far past the place of the catch. */
const FORCE_ARRIVE_SPEED = 30
const FORCE_STOP_DISTANCE = 3.4
/** How far the palm stays from the floating disc. */
export const FORCE_PALM_DISTANCE = 6.5
/** The roll of the forearm that turns the palm toward the disc and a little toward the camera. */
export const FORCE_ROLL = -3.05
/** Where the palm is, from the point of the raised hand that would hold a disc: out and down. */
const FORCE_PALM_OUT = 1.06
const FORCE_PALM_DOWN = 4.45
/** The hand is up this many seconds before the disc arrives, so that it stops the disc with its palm already raised. */
const FORCE_READY_BEFORE = 0.064

const forceSeconds = FORCE_STOP_SECONDS + FORCE_HOLD_SECONDS + FORCE_TAKE_SECONDS

/** The place where the disc stops, along the way that it comes. Exported for the tests. */
export function forceStopPoint(leg: Leg): Vec {
  const l = Math.hypot(leg.come[0], leg.come[1], leg.come[2]) || 1
  const k = FORCE_STOP_DISTANCE / l
  return [leg.arrive[0] + leg.come[0] * k, leg.arrive[1] + leg.come[1] * k, leg.arrive[2] + leg.come[2] * k]
}

/** The point of the raised hand, so that the palm is level with the disc and looks at it. */
function forceHandPoint(leg: Leg): Vec {
  const stop = forceStopPoint(leg)
  return [stop[0] + leg.dir * (FORCE_PALM_DISTANCE - FORCE_PALM_OUT), stop[1] + FORCE_PALM_DOWN, stop[2]]
}

const forceTrick: Trick = {
  catchSeconds: forceSeconds,
  arriveUnitsPerSecond: FORCE_ARRIVE_SPEED,
  writeDisc(disc, leg, on) {
    const stop = forceStopPoint(leg)
    const held = on - FORCE_STOP_SECONDS
    const taken = held - FORCE_HOLD_SECONDS
    if (held < 0) {
      hermite(leg.arrive, leg.come, stop, ZERO, FORCE_STOP_SECONDS, on, at)
    } else if (taken < 0) {
      // The disc shakes as it stops, then it floats.
      const shake = Math.exp(-held * 7) * Math.sin(held * 26) * 0.32
      const ease = swell(held / FORCE_HOLD_SECONDS)
      at[0] = stop[0] - leg.dir * shake * reach(held / 0.03)
      at[1] = stop[1] + Math.sin(held * 2.6) * 0.32 * ease
      at[2] = stop[2] + Math.sin(held * 1.7) * 0.2 * ease
    } else {
      hermite(stop, ZERO, leg.restTo, ZERO, FORCE_TAKE_SECONDS, taken, at)
    }
    putAt(disc, at)
    const settled = reach(on / FORCE_STOP_SECONDS)
    const off = reach(taken / FORCE_TAKE_SECONDS)
    const drift = 0.09 * reach(held / 0.25) * (1 - reach(taken / (FORCE_TAKE_SECONDS * 0.5)))
    disc.bank = mix(mix(leg.spec.bank[1], 0.3, settled), HOLD_BANK, off) + drift * Math.sin(on * 2.2)
    disc.nose = leg.dir * leg.spec.nose * (1 - settled) + drift * Math.cos(on * 1.6)
  },
  writeHand(hand, disc, leg, t, side) {
    const { caught } = leg
    const start = caught - FORCE_RAISE_SECONDS + FORCE_READY_BEFORE
    if (t < start) return holdReady(hand, leg)
    hand.wrist = 0
    const upright = -side * (Math.PI / 2)
    const place = forceHandPoint(leg)
    const on = t - caught
    const held = on - FORCE_STOP_SECONDS
    const taken = held - FORCE_HOLD_SECONDS
    if (taken < 0) {
      // The arm comes up fast and the palm turns to the disc, with the fingers wide.
      hermite(leg.readyTo, ZERO, place, ZERO, FORCE_RAISE_SECONDS, t - start, at)
      putAt(hand, at)
      const k = reach((t - start) / FORCE_RAISE_SECONDS)
      // The hand takes the shock of the impact, and it holds the disc there with small efforts.
      const shock = Math.exp(-Math.max(0, held) * 6) * Math.sin(Math.max(0, held) * 24) * 0.14
      const ease = swell(Math.max(0, held) / FORCE_HOLD_SECONDS)
      hand.x += side * shock
      hand.y += Math.sin(on * 2.6) * 0.12 * ease
      hand.nose = mix(0, upright, k) + Math.sin(on * 1.9) * 0.03 * ease
      hand.bank = mix(HOLD_BANK, 0.06, k)
      hand.roll = FORCE_ROLL * k
      hand.stand = k
      hand.push = k
      hand.open = mix(READY_OPEN, 1, k)
      return
    }
    if (taken < FORCE_TAKE_SECONDS) {
      // The disc drifts toward the hand, and the arm turns over and takes it.
      const k = taken / FORCE_TAKE_SECONDS
      hermite(place, ZERO, leg.restTo, ZERO, FORCE_TAKE_SECONDS, taken, at)
      putAt(hand, at)
      const back = reach(k / 0.92)
      hand.nose = mix(upright, disc.nose, back)
      hand.bank = mix(0.06, disc.bank, back)
      hand.roll = FORCE_ROLL * (1 - back)
      hand.stand = 1 - back
      hand.push = 1 - reach(k / 0.7)
      hand.open = 1 - reach((k - 0.8) / 0.2)
    }
  },
  spinShare(on) {
    // The spin slows as the disc stops, and it turns slowly as it floats. The catch stops it.
    const taken = FORCE_STOP_SECONDS + FORCE_HOLD_SECONDS
    return mix(0.72, 0.3, reach(on / (FORCE_STOP_SECONDS + 0.5))) * (1 - reach((on - taken - FORCE_TAKE_SECONDS * 0.6) / (FORCE_TAKE_SECONDS * 0.4)))
  },
}

export const TRICKS: Record<TrickName, Trick> = { spin: fingerSpin, backRoll, orbit: magneticOrbit, force: forceTrick }
export const TRICK_NAMES = Object.keys(TRICKS) as TrickName[]
