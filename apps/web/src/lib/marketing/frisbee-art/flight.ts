import {
  ABSORB_SECONDS,
  clamp01,
  DISC_RADIUS,
  HOLD_BANK,
  hermite,
  MEET_SECONDS,
  mix,
  putAt,
  reach,
  READY_OPEN,
  ZERO,
  type DiscPose,
  type HandIndex,
  type HandPose,
  type Leg,
  type ThrowSpec,
  type TrickName,
  type Vec,
} from "~/lib/marketing/frisbee-art/motion"
import {
  blendPose,
  copyPose,
  GRAB_SECONDS,
  launchDisc,
  LIFT_SECONDS,
  reachSeconds,
  SHOCK_SECONDS,
  stepDisc,
  WHY_SECONDS,
  writeGrab,
  writeLift,
  writeLooseDisc,
  writeReachDown,
  writeShock,
  writeTipped,
  writeWhy,
  type LooseDisc,
  type Shock,
} from "~/lib/marketing/frisbee-art/kick"
import { EDGE_DISTANCE, MAX_NORMAL_CATCHES, REST_BETWEEN_THROWS, SCENE_SIZE, TRICK_CHANCE } from "~/lib/marketing/frisbee-art/settings"
import { TRICKS, TRICK_NAMES } from "~/lib/marketing/frisbee-art/tricks"
import { seededRandom } from "~/lib/marketing/solve-art/cube"

export type { DiscPose, HandIndex, HandPose, ThrowSpec, TrickName } from "~/lib/marketing/frisbee-art/motion"

export { DISC_RADIUS } from "~/lib/marketing/frisbee-art/motion"
/** The distance from the center of the disc to the center of the palm that holds it. */
export const PALM_FROM_DISC = 4.45

/** The size of the hero in world units. */
export interface Field {
  /** How far from the center the disc leaves one hand and reaches the other. */
  span: number
  /** Half the height of the hero. */
  top: number
  /** The scale of the depth of a throw. A wide hero has a far camera, so its throws go deeper. */
  depth: number
  /** The height of the bottom line of the hero, where a dropped disc lands. */
  floor: number
  /** The distance from the center to the content, and to the side of the page. */
  inner: number
  edge: number
}

/**
 * The share of the hero that must be in the window for the art to count as seen. As the
 * visitor scrolls down, the bottom of the hero leaves last, and no hand and no disc
 * goes down into this share of it. The tests hold this.
 */
export const SEEN_SHARE = 0.2

/** How the art fits a hero of a size in CSS pixels. */
export interface Layout {
  /** CSS pixels for one world unit, at the depth of the hands. */
  unit: number
  /** The distance from the center to the side of the hero. */
  edge: number
  /** The distance of the camera. */
  distance: number
  field: Field
}

/** CSS pixels for one world unit at `SCENE_SIZE` 1: the gutter divided by this, within the limits below. */
const GUTTER_UNITS = 21.5
const MIN_PIXELS_PER_UNIT = 11
const MAX_PIXELS_PER_UNIT = 21.6
/** The width of the disc, the hand and the part of the arm that shows, in world units. */
const FIGURE_WIDTH = 16.3
/** A palm stays this far from the side of the page, so that a small window does not crop the hand. */
const MIN_PALM_TO_EDGE = 3.5
/** The camera looks down at the hero by this angle, in radians. */
export const CAMERA_ELEVATION = 0.1
/** How far a disc that lies on the floor stays from the bottom of the canvas, in CSS pixels. */
const FLOOR_GAP_PIXELS = 2

/** The height where the near edge of a disc that lies flat shows just above the bottom of the hero, with this camera. */
function floorHeight(height: number, unit: number, distance: number): number {
  const c = Math.cos(CAMERA_ELEVATION)
  const s = Math.sin(CAMERA_ELEVATION)
  const below = (height / 2 - FLOOR_GAP_PIXELS) / unit
  return -(below * (distance - c * DISC_RADIUS) - distance * s * DISC_RADIUS) / (distance * c - below * s)
}

/** The art for a hero of this size, with a gutter of this width beside its content. */
export function heroLayout(width: number, height: number, gutter: number): Layout {
  const unit = Math.min(MAX_PIXELS_PER_UNIT, Math.max(MIN_PIXELS_PER_UNIT, gutter / GUTTER_UNITS)) * SCENE_SIZE
  const edge = width / 2 / unit
  const gutterUnits = gutter / unit
  const top = height / 2 / unit
  // The middle of the gutter, or its inner edge when the gutter is small, gives the distance
  // from the palm to the side of the page. The hands then go closer to the side.
  const middle = edge - gutterUnits + Math.max(0, (gutterUnits - FIGURE_WIDTH) / 2)
  const palmToEdge = edge - (middle + DISC_RADIUS + PALM_FROM_DISC)
  const closer = Math.min(palmToEdge, Math.max(palmToEdge * EDGE_DISTANCE, MIN_PALM_TO_EDGE))
  const span = edge - closer - DISC_RADIUS - PALM_FROM_DISC
  const distance = Math.max(64, edge * 3)
  return { unit, edge, distance, field: { span, top, depth: top / 10, floor: floorHeight(height, unit, distance), inner: edge - gutterUnits, edge } }
}

/** The throws that the hands know. In flight the disc glides almost flat, and it banks a little. */
export const THROWS: readonly ThrowSpec[] = [
  {
    name: "line",
    seconds: 0.82,
    from: { y: 0.12, z: 0 },
    to: { y: 0.16, z: 0 },
    c1: { x: 0.34, y: 0.3, z: 2 },
    c2: { x: 0.68, y: 0.3, z: 2 },
    bank: [0.05, -0.02],
    nose: 0.05,
  },
  {
    name: "sweep",
    seconds: 1,
    from: { y: 0.04, z: 0 },
    to: { y: 0.3, z: 0 },
    c1: { x: 0.26, y: 0.34, z: -15 },
    c2: { x: 0.74, y: 0.5, z: -12 },
    bank: [0.5, 0.22],
    nose: 0.07,
  },
  {
    name: "float",
    seconds: 1.15,
    from: { y: 0.06, z: 0 },
    to: { y: 0.36, z: 0 },
    c1: { x: 0.28, y: 0.84, z: -3 },
    c2: { x: 0.72, y: 0.82, z: -2 },
    bank: [0.1, 0.16],
    nose: 0.16,
  },
  {
    name: "skim",
    seconds: 0.94,
    from: { y: 0.18, z: 0 },
    to: { y: -0.18, z: 0 },
    c1: { x: 0.3, y: -0.58, z: -11 },
    c2: { x: 0.7, y: -0.66, z: 10 },
    bank: [0.36, -0.14],
    nose: 0.02,
  },
]

const HOLD_SECONDS = REST_BETWEEN_THROWS
/** A long frame cannot step over this. With no rest in the settings, the art can still find a place to stop. */
const REST_WINDOW_SECONDS = Math.max(HOLD_SECONDS, 0.1)
/** Added to the seconds to a rest, so that rounding cannot stop the clock just before it. */
const REST_MARGIN_SECONDS = 1e-6
/** How far a hand lifts the disc and how far it tilts it in one slow breath, while it waits. */
const BREATH_LIFT = 0.28
const BREATH_TILT = 0.05
const WIND_SECONDS = 0.26
const SWING_SECONDS = 0.14
/** The share of the swing that passes before the wrist starts to whip open. */
const WHIP_START = 0.4
const SETTLE_SECONDS = 0.24
const FOLLOW_SECONDS = 0.24
const RETURN_SECONDS = 0.5
/** The curve of a disc in flight: it leaves fast, the air slows it, and it hangs before the catch. */
const LEAVE_SPEED = 1.45
const ARRIVE_SPEED = 0.62
/** Radians a second when the disc leaves the hand. */
const SPIN = 34
/** How far the wrist is cocked around the disc in the wind-up, and how far past the release it goes. */
const WIND_WRIST = 0.95
const RELEASE_WRIST = -0.1
const FOLLOW_WRIST = -0.5
/** How far the wrist breaks back as the disc lands. */
const CATCH_WRIST = 0.4
/** How far the forearm rolls over in the follow-through, and how far the hand points up. */
const FOLLOW_ROLL = -0.3
const FOLLOW_RISE = 0.3
const REST_HEIGHT = 0.06
/** Where a hand waits for the disc: how far past the place of the catch, and how far above the place of rest. */
const READY_FROM_SPAN = 1.4
const READY_LIFT = 0.4
/** How far a wind-up, a follow-through and the give of a catch can go, in world units. */
const WIND_REACH = 6.5
const FOLLOW_REACH = 5
const GIVE_REACH = 3.6
/** The fingers just after the release. */
const RELEASED_OPEN = 0.42

export interface FrisbeeTimeline {
  readonly disc: DiscPose
  readonly hands: [HandPose, HandPose]
  /** Moves the animation forward. */
  advance(seconds: number): void
  /** Writes the poses for a hero of this size. */
  write(field: Field): void
  /**
   * The seconds until a hand holds the disc and waits for the next throw, and 0 while
   * a hand waits. To advance by this many seconds always reaches the wait.
   */
  secondsToRest(): number
  /**
   * Hits a hand. `x` and `y` are the way of the hit on the screen, with y up and a length
   * of 1. A hand that has the disc loses it, and the hand gets angry at the visitor.
   */
  kick(hand: HandIndex, x: number, y: number): void
  /** The throw that is running, and the hand that throws it. */
  current(): { spec: ThrowSpec; thrower: HandIndex; count: number; trick: TrickName | null }
  /** What the kicks are doing now. */
  kicks(): { angry: [boolean, boolean]; owner: HandIndex | null; stage: LooseStage | null }
}

/** The stages of a disc that a hand lost: it waits on the floor, the hand reaches down, closes on it and lifts it. */
export type LooseStage = "wait" | "reach" | "grab" | "lift"

interface Loose {
  owner: HandIndex
  body: LooseDisc
  stage: LooseStage
  stageTime: number
  /** Where the hand starts to reach from, and how long it takes. */
  reachFrom: Vec
  reachTime: number
}

/** The seconds for a hand to take the pose of a hit or of a lost disc, from the pose that it has at that moment. */
const BLEND_HIT_SECONDS = 0.12
const BLEND_OTHER_SECONDS = 0.5
const BLEND_BACK_UP_SECONDS = 0.28
/** A fumbled disc bounces back off the hand with this share of its speed, and it pops up. */
const FUMBLE_BACK = 0.3
const FUMBLE_POP = 9
const FUMBLE_POWER = 0.6
/** The most time for one step of the game. Short steps keep the fall of a disc the same at any frame rate. */
const TICK_SECONDS = 1 / 120

/** The share of the path that a disc has flown at this share of its time. */
function flown(k: number, arriveSpeed: number): number {
  const k2 = k * k
  const k3 = k2 * k
  return (k3 - 2 * k2 + k) * LEAVE_SPEED + (-2 * k3 + 3 * k2) + (k3 - k2) * arriveSpeed
}

const scaleTo = (v: Vec, length: number): Vec => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [(v[0] / l) * length, (v[1] / l) * length, (v[2] / l) * length]
}

/** The points of one throw. Exported for the tests. */
export function buildLeg(spec: ThrowSpec, thrower: HandIndex, field: Field, trick: TrickName | null = null): Leg {
  const dir = thrower === 0 ? 1 : -1
  const catcher: HandIndex = thrower === 0 ? 1 : 0
  const { span, top, depth } = field
  const across = (x: number) => dir * span * (2 * x - 1)
  const release: Vec = [across(0), spec.from.y * top, spec.from.z * depth]
  const arrive: Vec = [across(1), spec.to.y * top, spec.to.z * depth]
  const c1: Vec = [across(spec.c1.x), spec.c1.y * top, spec.c1.z * depth]
  const c2: Vec = [across(spec.c2.x), spec.c2.y * top, spec.c2.z * depth]
  const T = spec.seconds
  const leave: Vec = [0, 1, 2].map((i) => ((c1[i] - release[i]) * 3 * LEAVE_SPEED) / T) as Vec
  // A trick can ask for a soft landing, so that the disc arrives slower than the normal throw.
  const lastPart = Math.hypot(arrive[0] - c2[0], arrive[1] - c2[1], arrive[2] - c2[2])
  const soft = trick ? TRICKS[trick].arriveUnitsPerSecond : undefined
  const arriveSpeed = soft === undefined ? ARRIVE_SPEED : Math.min(ARRIVE_SPEED, (soft * T) / (3 * lastPart))
  const come: Vec = [0, 1, 2].map((i) => ((arrive[i] - c2[i]) * 3 * arriveSpeed) / T) as Vec
  const comeSpeed = Math.hypot(come[0], come[1], come[2])

  // The arm winds up behind the line of the throw: back, down and in toward the body.
  const back = scaleTo(leave, WIND_REACH)
  const wind: Vec = [release[0] - back[0], release[1] - back[1] - 1.4, release[2] - back[2] - 3.4]
  const give = scaleTo(come, Math.min(comeSpeed * ABSORB_SECONDS * 0.42, GIVE_REACH))
  const absorb: Vec = [arrive[0] + give[0], arrive[1] + give[1], arrive[2] + give[2]]
  // The arm goes on along the throw, and it ends up higher and pointing at the catcher.
  const on = scaleTo(leave, FOLLOW_REACH)
  const follow: Vec = [release[0] + on[0], release[1] + on[1] + 1.8, release[2] + on[2] + 1.4]

  const restY = REST_HEIGHT * top
  const held = (side: number): Vec => [side * (span + DISC_RADIUS), restY, 0]
  const ready = (side: number): Vec => [side * (span + READY_FROM_SPAN), restY + READY_LIFT, 0]
  const released = HOLD_SECONDS + WIND_SECONDS + SWING_SECONDS
  const caught = released + T
  return {
    spec,
    thrower,
    catcher,
    dir,
    restFrom: held(-dir),
    restTo: held(dir),
    readyFrom: ready(-dir),
    readyTo: ready(dir),
    wind,
    release,
    leave,
    c1,
    c2,
    arrive,
    come,
    arriveSpeed,
    absorb,
    follow,
    trick,
    released,
    caught,
    seconds: legSeconds(spec, trick),
  }
}

const handPose = (): HandPose => ({ x: 0, y: 0, z: 0, bank: HOLD_BANK, nose: 0, wrist: 0, open: READY_OPEN, point: 0, gap: 0, flat: 0, slide: 0, along: 0, stand: 0, glow: 0, roll: 0, push: 0, claw: 0, clench: 0 })

/**
 * Deals the throws in a new random order each round, so the visitor sees all of them,
 * and a throw never follows itself. Exported for the tests.
 */
export function throwDealer(random: () => number): () => number {
  const deck: number[] = []
  let previous = -1
  return () => {
    if (deck.length === 0) {
      for (let i = 0; i < THROWS.length; i++) deck.splice(Math.floor(random() * (deck.length + 1)), 0, i)
      // The deck deals from its end. A new round must not start on the throw that just ran.
      if (deck[deck.length - 1] === previous) deck.unshift(deck.pop() as number)
    }
    previous = deck.pop() as number
    return previous
  }
}

/** The seconds of one throw at speed 1, from one hold to the next. Exported for the tests. */
export function legSeconds(spec: ThrowSpec, trick: TrickName | null = null): number {
  const catchSeconds = trick ? TRICKS[trick].catchSeconds : ABSORB_SECONDS + SETTLE_SECONDS
  return HOLD_SECONDS + WIND_SECONDS + SWING_SECONDS + spec.seconds + catchSeconds
}

/**
 * The game: one hand throws, the disc flies, the other hand catches it and throws it
 * back. The disc moves on one smooth path through the hold, the swing, the flight and
 * the catch, and a hand that holds it follows it, so nothing jumps at a release or at
 * a catch. It keeps time only while it advances.
 */
export function createFrisbeeTimeline(options: { seed: number; speed?: number }): FrisbeeTimeline {
  const { speed = 1 } = options
  const deal = throwDealer(seededRandom(options.seed))
  const coin = seededRandom(options.seed + 1)
  let lastTrick: TrickName | null = null
  let normalsInARow = 0
  /**
   * Picks a trick for the next catch, or none. A trick comes for sure after too many
   * normal catches, and a trick differs from the last trick.
   */
  const pickTrick = (): TrickName | null => {
    const due = TRICK_CHANCE > 0 && normalsInARow >= MAX_NORMAL_CATCHES
    if (!due && coin() >= TRICK_CHANCE) {
      normalsInARow += 1
      return null
    }
    normalsInARow = 0
    const others = TRICK_NAMES.filter((name) => name !== lastTrick)
    lastTrick = others[Math.floor(coin() * others.length)]
    return lastTrick
  }
  let index = deal()
  let trick = pickTrick()
  let thrower: HandIndex = 0
  let count = 0
  let clock = 0
  let elapsed = 0
  let spin = 0

  const disc: DiscPose = { x: 0, y: 0, z: 0, bank: HOLD_BANK, nose: 0, spin: 0, flying: false, balancing: false }
  const hands: [HandPose, HandPose] = [handPose(), handPose()]
  const at: Vec = [0, 0, 0]

  // What the clicks did.
  const shocks: [Shock | null, Shock | null] = [null, null]
  /** The seconds of the "why?!" of each hand, or null. */
  const whys: [number | null, number | null] = [null, null]
  /** The pose of a hand at the moment of a hit, and how long ago that was. It covers the change of pose. */
  const carried: [HandPose, HandPose] = [handPose(), handPose()]
  const carryTime = [0, 0]
  const carrySeconds = [0, 0]
  const whyPose = handPose()
  let loose: Loose | null = null
  let world: Field | null = null
  /** The disc in the last frame, for its speed. */
  const lastDisc: Vec = [0, 0, 0]
  const discSpeed: Vec = [0, 0, 0]
  let lastDiscTime = -1
  const tipped: DiscPose = { x: 0, y: 0, z: 0, bank: 0, nose: 0, spin: 0, flying: true, balancing: false }

  const sideOf = (h: HandIndex) => (h === 0 ? -1 : 1)
  const otherOf = (h: HandIndex): HandIndex => (h === 0 ? 1 : 0)
  const catcherNow = () => otherOf(thrower)
  const heldAt = (h: HandIndex, field: Field): Vec => [sideOf(h) * (field.span + DISC_RADIUS), REST_HEIGHT * field.top, 0]
  const readyAt = (h: HandIndex, field: Field): Vec => [sideOf(h) * (field.span + READY_FROM_SPAN), REST_HEIGHT * field.top + READY_LIFT, 0]

  const carry = (h: HandIndex, seconds: number) => {
    copyPose(carried[h], hands[h])
    carryTime[h] = 0
    carrySeconds[h] = seconds
  }

  /** The disc is free. The game waits, and `owner` must pick it up. */
  const lose = (owner: HandIndex, body: LooseDisc) => {
    loose = { owner, body, stage: "wait", stageTime: 0, reachFrom: [0, 0, 0], reachTime: 0 }
    carry(owner, BLEND_HIT_SECONDS)
    carry(otherOf(owner), BLEND_OTHER_SECONDS)
    disc.flying = true
    disc.balancing = false
  }

  const hasDisc = (h: HandIndex) => {
    if (loose) return loose.owner === h && (loose.stage === "grab" || loose.stage === "lift")
    const released = HOLD_SECONDS + WIND_SECONDS + SWING_SECONDS
    return h === thrower ? clock < released : clock >= released + THROWS[index].seconds
  }

  /** The disc hits a hand that is too angry to catch it: it bounces off and it falls. */
  const fumble = (field: Field) => {
    const leg = buildLeg(THROWS[index], thrower, field, trick)
    const owner = leg.catcher
    const from: DiscPose = { ...disc, x: leg.arrive[0], y: leg.arrive[1], z: leg.arrive[2] }
    const speed: Vec = [-leg.come[0] * FUMBLE_BACK, FUMBLE_POP, leg.come[2] * FUMBLE_BACK]
    lose(owner, launchDisc(from, speed, { x: 0, y: 0 }, spinRate(clock), field, coin))
    shocks[owner] = { since: 0, x: leg.dir, y: -0.3, power: FUMBLE_POWER }
  }

  /** A new throw, from the hand that picked the disc up. */
  const backInGame = (owner: HandIndex) => {
    loose = null
    thrower = owner
    index = deal()
    trick = pickTrick()
    clock = 0
    count += 1
  }

  const stepLoose = (l: Loose, step: number, field: Field) => {
    const side = sideOf(l.owner)
    spin += l.body.spinRate * step
    l.stageTime += step
    if (l.stage === "wait") {
      stepDisc(l.body, step, field)
      if (l.body.settled && whys[l.owner] === null) {
        l.stage = "reach"
        l.stageTime = 0
        l.reachFrom = readyAt(l.owner, field)
        writeTipped(tipped, l.body, 1, side, field)
        l.reachTime = reachSeconds(l.reachFrom, [tipped.x, tipped.y, tipped.z])
      }
    } else if (l.stage === "reach") {
      if (l.stageTime >= l.reachTime) {
        l.stage = "grab"
        l.stageTime = 0
      }
    } else if (l.stage === "grab") {
      if (l.stageTime >= GRAB_SECONDS) {
        l.stage = "lift"
        l.stageTime = 0
      }
    } else if (l.stageTime >= LIFT_SECONDS) {
      backInGame(l.owner)
    }
  }

  const stepGame = (step: number) => {
    const released = HOLD_SECONDS + WIND_SECONDS + SWING_SECONDS
    const caught = released + THROWS[index].seconds
    const before = clock
    // The hand with the disc waits until the other hand has calmed down.
    if (clock < HOLD_SECONDS && clock + step >= HOLD_SECONDS && whys[catcherNow()] !== null) return
    clock += step
    spin += spinRate(clock) * step
    if (before < caught && clock >= caught && whys[catcherNow()] !== null && world) return fumble(world)
    if (clock >= legSeconds(THROWS[index], trick)) {
      clock -= legSeconds(THROWS[index], trick)
      thrower = otherOf(thrower)
      index = deal()
      trick = pickTrick()
      count += 1
    }
  }

  const tick = (step: number) => {
    elapsed += step
    for (const h of [0, 1] as HandIndex[]) {
      carryTime[h] += step
      const shock = shocks[h]
      if (shock) {
        shock.since += step
        if (shock.since > SHOCK_SECONDS) shocks[h] = null
      }
      const why = whys[h]
      if (why !== null) whys[h] = why + step >= WHY_SECONDS ? null : why + step
    }
    if (loose && world) stepLoose(loose, step, world)
    else stepGame(step)
  }

  const writeLoose = (l: Loose, field: Field) => {
    const owner = hands[l.owner]
    const side = sideOf(l.owner)
    const other = hands[otherOf(l.owner)]
    putAt(other, readyAt(otherOf(l.owner), field))
    other.bank = HOLD_BANK
    other.nose = 0
    other.wrist = 0
    other.open = READY_OPEN
    if (l.stage === "wait") {
      writeLooseDisc(disc, l.body)
      putAt(owner, readyAt(l.owner, field))
      owner.bank = HOLD_BANK
      owner.nose = 0
      owner.wrist = 0
      owner.open = READY_OPEN
    } else if (l.stage === "reach") {
      writeLooseDisc(disc, l.body)
      writeTipped(tipped, l.body, 1, side, field)
      writeReachDown(owner, l.reachFrom, tipped, Math.min(1, l.stageTime / l.reachTime))
    } else if (l.stage === "grab") {
      const k = Math.min(1, l.stageTime / GRAB_SECONDS)
      writeTipped(disc, l.body, k, side, field)
      writeTipped(tipped, l.body, 1, side, field)
      writeGrab(owner, tipped, k)
    } else {
      writeTipped(tipped, l.body, 1, side, field)
      writeLift(disc, tipped, heldAt(l.owner, field), Math.min(1, l.stageTime / LIFT_SECONDS))
      owner.x = disc.x
      owner.y = disc.y
      owner.z = disc.z
      owner.bank = disc.bank
      owner.nose = disc.nose
      owner.wrist = 0
      owner.open = 0
    }
    disc.spin = spin
  }

  /** The speed of the spin at this time of the throw that is running. */
  const spinRate = (t: number) => {
    const spec = THROWS[index]
    const dir = thrower === 0 ? 1 : -1
    const released = HOLD_SECONDS + WIND_SECONDS + SWING_SECONDS
    const caught = released + spec.seconds
    const start = released - SWING_SECONDS * (1 - WHIP_START)
    if (t < start) return 0
    if (t < released) return dir * SPIN * reach((t - start) / (released - start))
    if (t < caught) return dir * SPIN * mix(1, 0.72, (t - released) / spec.seconds)
    if (trick) return dir * SPIN * TRICKS[trick].spinShare(t - caught)
    return dir * SPIN * 0.72 * (1 - reach((t - caught) / (ABSORB_SECONDS * 0.6)))
  }

  const writeDisc = (leg: Leg, t: number) => {
    const { spec, released, caught, seconds } = leg
    // A hand that waits is not a statue: it takes one slow breath.
    const breath = t < HOLD_SECONDS ? Math.sin((Math.PI * t) / HOLD_SECONDS) ** 2 : 0
    if (t < HOLD_SECONDS) {
      hermite(leg.restFrom, ZERO, leg.restFrom, ZERO, HOLD_SECONDS, t, at)
      at[1] += BREATH_LIFT * breath
    } else if (t < HOLD_SECONDS + WIND_SECONDS) {
      hermite(leg.restFrom, ZERO, leg.wind, ZERO, WIND_SECONDS, t - HOLD_SECONDS, at)
    } else if (t < released) {
      hermite(leg.wind, ZERO, leg.release, leg.leave, SWING_SECONDS, t - HOLD_SECONDS - WIND_SECONDS, at)
    } else if (t < caught) {
      const u = flown((t - released) / spec.seconds, leg.arriveSpeed)
      const w = 1 - u
      for (let i = 0; i < 3; i++) {
        at[i] = w * w * w * leg.release[i] + 3 * w * w * u * leg.c1[i] + 3 * w * u * u * leg.c2[i] + u * u * u * leg.arrive[i]
      }
    } else if (t < caught + ABSORB_SECONDS) {
      hermite(leg.arrive, leg.come, leg.absorb, ZERO, ABSORB_SECONDS, t - caught, at)
    } else {
      hermite(leg.absorb, ZERO, leg.restTo, ZERO, SETTLE_SECONDS, t - caught - ABSORB_SECONDS, at)
    }
    disc.x = at[0]
    disc.y = at[1]
    disc.z = at[2]
    disc.flying = t >= released && t < caught
    disc.balancing = leg.trick !== null && t >= caught
    disc.spin = spin
    // After the disc reaches the hand, a trick writes it.
    if (leg.trick && t >= caught) return TRICKS[leg.trick].writeDisc(disc, leg, t - caught)

    const tau = clamp01((t - released) / spec.seconds)
    // A spinning disc wobbles a little as it leaves the hand, and it steadies in the air.
    const wobble = t >= released && t < caught ? Math.sin(spin) * 0.035 * Math.sin(Math.PI * tau) * (1 - tau) : 0
    if (t < released) {
      const k = reach((t - HOLD_SECONDS) / (WIND_SECONDS + SWING_SECONDS))
      disc.bank = mix(HOLD_BANK, spec.bank[0], k) + BREATH_TILT * breath
      disc.nose = mix(0, leg.dir * spec.nose, k)
    } else if (t < caught) {
      disc.bank = mix(spec.bank[0], spec.bank[1], reach(tau)) + wobble
      disc.nose = leg.dir * spec.nose
    } else {
      const k = reach((t - caught) / (seconds - caught))
      disc.bank = mix(spec.bank[1], HOLD_BANK, k)
      disc.nose = mix(leg.dir * spec.nose, 0, k)
    }
  }

  const writeThrower = (hand: HandPose, leg: Leg, t: number, side: number) => {
    const { released } = leg
    if (t < released) {
      hand.x = disc.x
      hand.y = disc.y
      hand.z = disc.z
      hand.bank = disc.bank
      hand.nose = disc.nose
      hand.open = 0
      const wound = reach((t - HOLD_SECONDS) / WIND_SECONDS)
      // The arm leads and the wrist stays cocked. It whips open late in the swing.
      const whip = reach(((t - HOLD_SECONDS - WIND_SECONDS) / SWING_SECONDS - WHIP_START) / (1 - WHIP_START))
      hand.wrist = -side * mix(mix(0, WIND_WRIST, wound), RELEASE_WRIST, whip)
      return
    }
    const after = t - released
    if (after < FOLLOW_SECONDS) hermite(leg.release, leg.leave, leg.follow, ZERO, FOLLOW_SECONDS, after, at)
    else hermite(leg.follow, ZERO, leg.readyFrom, ZERO, RETURN_SECONDS, after - FOLLOW_SECONDS, at)
    hand.x = at[0]
    hand.y = at[1]
    hand.z = at[2]
    const out = reach(after / FOLLOW_SECONDS)
    const back = reach((after - FOLLOW_SECONDS) / RETURN_SECONDS)
    hand.bank = mix(mix(leg.spec.bank[0], FOLLOW_ROLL, out), HOLD_BANK, back)
    hand.nose = mix(mix(leg.dir * leg.spec.nose, leg.dir * FOLLOW_RISE, out), 0, back)
    hand.wrist = -side * mix(mix(RELEASE_WRIST, FOLLOW_WRIST, out), 0, back)
    hand.open = mix(reach(after / 0.07) * RELEASED_OPEN, READY_OPEN, reach((after - 0.08) / RETURN_SECONDS))
  }

  const writeCatcher = (hand: HandPose, leg: Leg, t: number, side: number) => {
    const { caught } = leg
    const meet = caught - MEET_SECONDS
    if (t >= caught) {
      hand.x = disc.x
      hand.y = disc.y
      hand.z = disc.z
      hand.bank = disc.bank
      hand.nose = disc.nose
    } else {
      if (t < meet) hermite(leg.readyTo, ZERO, leg.readyTo, ZERO, 1, 0, at)
      else hermite(leg.readyTo, ZERO, leg.arrive, leg.come, MEET_SECONDS, t - meet, at)
      hand.x = at[0]
      hand.y = at[1]
      hand.z = at[2]
      const k = reach((t - meet) / MEET_SECONDS)
      hand.bank = mix(HOLD_BANK, leg.spec.bank[1], k)
      hand.nose = mix(0, leg.dir * leg.spec.nose, k)
    }
    // The wrist breaks back as the disc lands, and it comes up again as the arm settles.
    const broke = reach((t - caught + 0.02) / (ABSORB_SECONDS * 0.7))
    const up = reach((t - caught - ABSORB_SECONDS * 0.5) / SETTLE_SECONDS)
    hand.wrist = -side * CATCH_WRIST * broke * (1 - up)
    // The fingers open wide as the disc comes, and they close on it in a moment.
    const wide = mix(READY_OPEN, 1, reach((t - meet) / (MEET_SECONDS * 0.7)))
    hand.open = wide * (1 - reach((t - (caught - 0.03)) / 0.08))
  }

  return {
    disc,
    hands,
    advance(seconds) {
      // A long step can finish more than one throw. The catcher holds the disc, so the
      // next throw starts from there.
      let left = seconds * speed
      while (left > 0) {
        const step = Math.min(left, TICK_SECONDS)
        tick(step)
        left -= step
      }
    },
    write(field) {
      world = field
      for (const hand of hands) {
        hand.point = 0
        hand.gap = 0
        hand.flat = 0
        hand.slide = 0
        hand.along = 0
        hand.stand = 0
        hand.glow = 0
        hand.roll = 0
        hand.push = 0
        hand.claw = 0
        hand.clench = 0
      }
      let quietHand: HandIndex = 0
      let quiet = 1
      if (loose) {
        writeLoose(loose, field)
        quietHand = loose.owner
        quiet = loose.stage === "wait" ? 1 : 0
      } else {
        const leg = buildLeg(THROWS[index], thrower, field, trick)
        writeDisc(leg, clock)
        writeThrower(hands[leg.thrower], leg, clock, sideOf(leg.thrower))
        if (trick) TRICKS[trick].writeHand(hands[leg.catcher], disc, leg, clock, sideOf(leg.catcher))
        else writeCatcher(hands[leg.catcher], leg, clock, sideOf(leg.catcher))
        // The catcher is still as the disc comes.
        quietHand = leg.catcher
        quiet = 1 - reach((clock - (leg.caught - MEET_SECONDS)) / (MEET_SECONDS * 0.6))
      }
      for (const h of [0, 1] as HandIndex[]) {
        const hand = hands[h]
        // A hand that holds nothing is never quite still.
        const calm = hand.open * (h === quietHand ? quiet : 1)
        hand.y += Math.sin(elapsed * 1.7 + h * 2) * 0.16 * calm
        hand.x += Math.cos(elapsed * 1.1 + h) * 0.1 * calm
        const why = whys[h]
        if (why !== null) {
          const share = writeWhy(whyPose, why, sideOf(h), readyAt(h, field))
          blendPose(hand, whyPose, share)
        }
        // The pose at the moment of the hit gives way to the new pose, with no jump.
        if (carryTime[h] < carrySeconds[h]) blendPose(hand, carried[h], 1 - reach(carryTime[h] / carrySeconds[h]))
        const shock = shocks[h]
        if (shock) writeShock(hand, shock, sideOf(h))
      }
      if (elapsed > lastDiscTime && lastDiscTime >= 0) {
        const seconds = elapsed - lastDiscTime
        discSpeed[0] = (disc.x - lastDisc[0]) / seconds
        discSpeed[1] = (disc.y - lastDisc[1]) / seconds
        discSpeed[2] = (disc.z - lastDisc[2]) / seconds
      }
      lastDisc[0] = disc.x
      lastDisc[1] = disc.y
      lastDisc[2] = disc.z
      lastDiscTime = elapsed
    },
    secondsToRest() {
      const angry = Math.max(whys[0] === null ? 0 : WHY_SECONDS - whys[0], whys[1] === null ? 0 : WHY_SECONDS - whys[1])
      if (loose) {
        // A disc on its way to the floor can take longer than this. More steps then follow.
        const left =
          loose.stage === "wait"
            ? GRAB_SECONDS + LIFT_SECONDS
            : loose.stage === "reach"
              ? loose.reachTime - loose.stageTime + GRAB_SECONDS + LIFT_SECONDS
              : loose.stage === "grab"
                ? GRAB_SECONDS - loose.stageTime + LIFT_SECONDS
                : LIFT_SECONDS - loose.stageTime
        return Math.max(angry, left) / speed + REST_MARGIN_SECONDS
      }
      if (clock < REST_WINDOW_SECONDS) return angry > 0 ? angry / speed + REST_MARGIN_SECONDS : 0
      return Math.max(angry, legSeconds(THROWS[index], trick) - clock) / speed + REST_MARGIN_SECONDS
    },
    kick(h, x, y) {
      shocks[h] = { since: 0, x, y, power: 1 }
      // A hit in the first part of a "why?!" only makes it worse. A later one starts it again.
      const why = whys[h]
      if (why === null || why > WHY_SECONDS * 0.5) {
        carry(h, BLEND_HIT_SECONDS)
        whys[h] = 0
      }
      if (!world) return
      if (hasDisc(h)) {
        lose(h, launchDisc(disc, discSpeed, { x, y }, spinRate(clock), world, coin))
      } else if (loose && loose.owner === h && loose.stage === "reach") {
        // The hand has not reached the disc yet. It starts again after the "why?!".
        carry(h, BLEND_BACK_UP_SECONDS)
        loose.stage = "wait"
        loose.stageTime = 0
      }
    },
    current: () => ({ spec: THROWS[index], thrower, count, trick }),
    kicks: () => ({ angry: [whys[0] !== null, whys[1] !== null], owner: loose ? loose.owner : null, stage: loose ? loose.stage : null }),
  }
}
