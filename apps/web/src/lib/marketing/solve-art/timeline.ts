import { applyOp, invertOps, opLayer, seededRandom, solveOps, type Axis, type Cubie, type Op } from "~/lib/marketing/solve-art/cube"

export const FINGERS = 5
export const INDEX = 0
export const MIDDLE = 1
export const LITTLE = 3
export const THUMB = 4

/** The hand on the -x side is hand 0, and the hand on the +x side is hand 1. */
export type HandIndex = 0 | 1

export interface HandPose {
  /** The rock of the wrist around x. The layer turns a quarter while the wrist rocks part of that. */
  rock: number
  /** The angle of a whole cube that this hand carries, around x. */
  carry: number
  /** 0 is on the cube. 1 is a relaxed, open hand. */
  open: number
  /** 0 is at the cube. 1 is well clear of it. */
  away: number
  /** How far each fingertip lifts off its face, from 0 to 1. */
  lift: number[]
  /** How far each fingertip has gone from its rest to the layer that it pushes, from 0 to 1. */
  touch: number[]
  /** How far each fingertip has pushed the layer, from 0 to 1. */
  sweep: number[]
}

/** Everything that moves, for one moment of the animation. */
export interface Pose {
  hands: [HandPose, HandPose]
  /** The way that the hands hold the whole cube: it tilts all the time, as in a real solve. */
  yaw: number
  pitch: number
  roll: number
  /** How hard hand 1 shakes the cube, from 0 to 1, and the phase of the shake. */
  shake: number
  shakePhase: number
  /** The move that is running. `coord` 0 is the whole cube. */
  turn: { axis: Axis; coord: number; angle: number } | null
  /** 0 to 1: the short lift in brightness when the cube is solved. */
  glow: number
}

export type Stage = "solving" | "solved" | "changed"

export interface Timeline {
  readonly pose: Pose
  /** Moves the animation forward. */
  advance(seconds: number): void
  /** The part of the loop that is running. */
  stage(): Stage
}

const QUARTER = Math.PI / 2

/** Seconds for one move. A real cuber is fastest with a flick of one finger. */
const FLICK_SECONDS = 0.1
const WRIST_SECONDS = 0.13
const THUMB_SECONDS = 0.13
const ROLL_SECONDS = 0.3
/** Seconds for the hand that carried a roll to come back to its rest. */
const ROLL_BACK_SECONDS = 0.24
/** How far a wrist rocks from its rest, each way. */
const ROCK = 0.38
/** Seconds for a wrist to let go and come back to its rest. */
const REGRIP_SECONDS = 0.11
/** Seconds for a fingertip to reach the layer before it pushes. */
const COCK_SECONDS = 0.05
/** Seconds that the hands hold the first look at a scrambled cube. */
const FIRST_LOOK_SECONDS = 0.18
const SOLVED_SECONDS = 1
const SHAKE_SECONDS = 1.1
/** Oscillations a second in the shake. */
const SHAKE_RATE = 7.5

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** The speed curve of a human reach: no jump in speed or in acceleration at either end. */
const reach = (x: number) => {
  const k = clamp01(x)
  return k * k * k * (k * (k * 6 - 15) + 10)
}

/** A layer goes fast into the turn and a little past the quarter. It then seats. */
function turnCurve(x: number): number {
  const seat = Math.sin(Math.PI * clamp01((x - 0.6) / 0.4))
  return reach(x) + 0.04 * seat * seat
}

/** Values of one channel in time: t0, v0, t1, v1, and so on. */
type Track = number[]

const last = (track: Track) => track[track.length - 1]

/** The channel holds its value until `start`, then it moves to `to` over `seconds`. */
function move(track: Track, start: number, seconds: number, to: number): void {
  const from = Math.max(start, track[track.length - 2])
  track.push(from, last(track), from + seconds, to)
}

/** A quick move away from the value and back. */
function bump(track: Track, start: number, seconds: number, size: number): void {
  const rest = last(track)
  move(track, start, seconds * 0.45, rest + size)
  move(track, start + seconds * 0.45, seconds * 0.55, rest)
}

function sample(track: Track, t: number): number {
  let i = track.length - 2
  while (i > 0 && track[i] > t) i -= 2
  if (i === track.length - 2) return track[i + 1]
  const from = track[i + 1]
  const to = track[i + 3]
  return from === to ? from : from + (to - from) * reach((t - track[i]) / (track[i + 2] - track[i]))
}

interface HandTracks {
  rock: Track
  carry: Track
  open: Track
  away: Track
  lift: Track[]
  touch: Track[]
  sweep: Track[]
}

interface Tracks {
  hands: [HandTracks, HandTracks]
  yaw: Track
  pitch: Track
  roll: Track
  kickPitch: Track
  kickRoll: Track
  shake: Track
}

interface TimedOp {
  op: Op
  start: number
  end: number
  /** The hand whose wrist carries the layer, if one does. */
  carrier: HandIndex | null
}

/** The motion of both hands for one stage of the loop. */
interface Plan {
  seconds: number
  ops: TimedOp[]
  tracks: Tracks
}

const fingerTracks = (from?: Track[]): Track[] => Array.from({ length: FINGERS }, (_, f) => [0, from ? last(from[f]) : 0])

function handTracks(from?: HandTracks): HandTracks {
  return {
    rock: [0, from ? last(from.rock) : 0],
    carry: [0, from ? last(from.carry) : 0],
    open: [0, from ? last(from.open) : 0],
    away: [0, from ? last(from.away) : 0],
    lift: fingerTracks(from?.lift),
    touch: fingerTracks(from?.touch),
    sweep: fingerTracks(from?.sweep),
  }
}

/** New tracks that start where `from` ends. */
function tracksFrom(from?: Tracks): Tracks {
  return {
    hands: [handTracks(from?.hands[0]), handTracks(from?.hands[1])],
    yaw: [0, from ? last(from.yaw) : 0.16],
    pitch: [0, from ? last(from.pitch) : 0.16],
    roll: [0, from ? last(from.roll) : 0],
    kickPitch: [0, 0],
    kickRoll: [0, 0],
    shake: [0, 0],
  }
}

/** The time at which every channel has finished, so a new stage never cuts a motion short. */
function endOf(tracks: Tracks): number {
  const hands = tracks.hands.flatMap((hand) => [hand.rock, hand.carry, hand.open, hand.away, ...hand.lift, ...hand.touch, ...hand.sweep])
  return Math.max(...[...hands, tracks.yaw, tracks.pitch, tracks.roll, tracks.kickPitch, tracks.kickRoll, tracks.shake].map((track) => track[track.length - 2]))
}

/** Lets go, brings the wrist back to its rest, and takes the grip again. */
function regrip(hand: HandTracks, start: number, seconds = REGRIP_SECONDS): number {
  move(hand.open, start, seconds * 0.5, 0.45)
  move(hand.rock, start + seconds * 0.08, seconds * 0.8, 0)
  move(hand.carry, start + seconds * 0.08, seconds * 0.8, 0)
  move(hand.open, start + seconds * 0.5, seconds * 0.5, 0)
  return start + seconds
}

/**
 * Plans a solve as the hands of a speedcuber do it. The cube stays in the fingers of
 * both hands, and each move is a small motion:
 *
 * - R and L: the wrist on that side rocks, and the fingertips drag along the face while
 *   the layer spins a quarter.
 * - U and D: one fingertip flicks the layer, and the layer spins on by itself. Two
 *   flicks in a row use the index and then the middle finger.
 * - F: the thumb pushes the far layer up.
 * - A roll of the cube: one hand carries it, and the other opens wide and takes a new
 *   grip.
 *
 * Each hand prepares for its next move while the other hand works.
 */
function planSolve(ops: readonly Op[], from: Tracks, seed: number): Plan {
  const tracks = tracksFrom(from)
  const { hands } = tracks
  const timed: TimedOp[] = []
  const random = seededRandom(seed)
  let t = FIRST_LOOK_SECONDS
  const free = [0, 0]
  const wristAt = [last(hands[0].rock) + last(hands[0].carry), last(hands[1].rock) + last(hands[1].carry)]

  /** Brings a wrist back to its rest, and starts early enough to be ready at `t`. */
  const readyWrist = (h: HandIndex) => {
    if (wristAt[h] !== 0) {
      free[h] = regrip(hands[h], Math.max(free[h], t - REGRIP_SECONDS))
      wristAt[h] = 0
    }
    t = Math.max(t, free[h])
  }

  const flick = (h: HandIndex, f: number, seconds: number) => {
    const hand = hands[h]
    // The fingertip draws back a little before it strikes.
    move(hand.sweep[f], t - COCK_SECONDS, 0, -0.3)
    move(hand.touch[f], t - COCK_SECONDS, COCK_SECONDS, 1)
    move(hand.sweep[f], t, seconds * 0.7, 1)
    move(hand.touch[f], t + seconds * 0.6, seconds * 0.6, 0)
    move(hand.sweep[f], t + seconds * 1.2, 0, 0)
    free[h] = Math.max(free[h], t + seconds)
  }

  /** A finger that is not at work seats itself again, as a real grip does all the time. */
  const reseat = (actor: HandIndex | null, finger: number | null) => {
    if (random() > 0.7) return
    const h = random() < 0.5 ? 0 : 1
    const f = Math.floor(random() * FINGERS)
    if (h === actor && f === finger) return
    bump(hands[h].lift[f], t, 0.13, 0.7)
  }

  ops.forEach((op, i) => {
    const pace = 0.9 + random() * 0.22
    t += op.beat ?? 0
    if ((op.beat ?? 0) > 0.1) {
      // Between stages of the solve, the hands turn the cube to look at it.
      move(tracks.yaw, t - 0.22, 0.34, -0.3 + random() * 0.6)
      move(tracks.pitch, t - 0.22, 0.34, 0.02 + random() * 0.3)
      move(tracks.roll, t - 0.22, 0.34, -0.14 + random() * 0.28)
    }

    if (op.kind === "roll") {
      const holder: HandIndex = random() < 0.5 ? 0 : 1
      const other: HandIndex = holder === 0 ? 1 : 0
      readyWrist(holder)
      readyWrist(other)
      move(hands[other].open, t, 0.12, 1)
      move(hands[other].away, t, 0.11, 0.42)
      const start = t + 0.06
      const end = start + ROLL_SECONDS * pace
      timed.push({ op, start, end, carrier: holder })
      const angle = op.dir * QUARTER
      // The roll adds to the carry while it runs, and this step replaces it when it ends.
      move(hands[holder].carry, end, 0, angle)
      wristAt[holder] = angle
      move(hands[other].away, end - 0.12, 0.14, 0)
      move(hands[other].open, end - 0.1, 0.14, 0)
      free[other] = end + 0.04
      // The other hand holds again, so this hand can come back to its rest.
      free[holder] = regrip(hands[holder], end + 0.03, ROLL_BACK_SECONDS)
      wristAt[holder] = 0
      t = end + 0.04
      return
    }

    let wrist: HandIndex | null = null
    let seconds = FLICK_SECONDS * pace
    let actor: HandIndex
    let finger: number | null = null
    if (op.face === "R" || op.face === "L") {
      actor = op.face === "R" ? 0 : 1
      wrist = actor
      seconds = WRIST_SECONDS * pace
      const { sign } = opLayer(op)
      // A wrist rocks each way from its rest. Past that, it takes a new grip.
      if (Math.abs(wristAt[actor] + sign * ROCK) > ROCK + 0.01) readyWrist(actor)
      t = Math.max(t, free[actor])
    } else if (op.face === "U") {
      actor = op.dir > 0 ? 1 : 0
      const previous = ops[i - 1]
      const again = previous?.kind === "turn" && previous.face === "U" && previous.dir === op.dir
      finger = again && wristAt[actor] === 0 ? MIDDLE : INDEX
    } else {
      // D flicks with the little finger, and F pushes with the thumb. These need the hand at its rest.
      actor = op.face === "D" ? (op.dir > 0 ? 0 : 1) : op.dir > 0 ? 1 : 0
      finger = op.face === "D" ? LITTLE : THUMB
      if (op.face === "F") seconds = THUMB_SECONDS * pace
      readyWrist(actor)
    }

    const start = t
    const end = start + seconds
    timed.push({ op, start, end, carrier: null })
    if (wrist !== null) {
      const { sign } = opLayer(op)
      wristAt[wrist] += sign * ROCK
      move(hands[wrist].rock, start - 0.015, seconds, wristAt[wrist])
      free[wrist] = end
      bump(tracks.kickPitch, start, seconds * 1.5, sign * 0.045)
    } else if (finger !== null) {
      flick(actor, finger, seconds)
      bump(tracks.kickRoll, start, seconds * 1.5, (actor === 0 ? 0.03 : -0.03))
    }
    reseat(actor, finger)
    t = end
  })

  return { seconds: Math.max(t, endOf(tracks)), ops: timed, tracks }
}

/** The hands hold the solved cube up. Then hand 0 lets go, so hand 1 holds it alone. */
function planSolved(from: Tracks): Plan {
  const tracks = tracksFrom(from)
  const [other, holder] = tracks.hands
  regrip(holder, 0)
  regrip(other, 0)
  move(tracks.yaw, 0.04, 0.42, 0.2)
  move(tracks.pitch, 0.04, 0.42, 0.24)
  move(tracks.roll, 0.04, 0.42, 0)
  move(other.open, 0.3, 0.2, 1)
  move(other.away, 0.32, 0.42, 1)
  return { seconds: SOLVED_SECONDS, ops: [], tracks }
}

/**
 * One hand shakes the cube, and the cube is scrambled when the shake ends. The hands
 * make no moves here: the layers rattle, and the scramble lands while they do.
 */
function planShake(scramble: readonly Op[], from: Tracks): Plan {
  const tracks = tracksFrom(from)
  const [other] = tracks.hands
  move(tracks.shake, 0, 0.14, 1)
  move(tracks.shake, 0.66, 0.2, 0)
  const timed = scramble.map((op, i): TimedOp => {
    const at = 0.14 + (0.5 * i) / scramble.length
    return { op, start: at, end: at, carrier: null }
  })
  move(other.away, 0.68, 0.36, 0)
  move(other.open, 0.78, 0.3, 0)
  return { seconds: SHAKE_SECONDS, ops: timed, tracks }
}

const handPose = (): HandPose => ({
  rock: 0,
  carry: 0,
  open: 0,
  away: 0,
  lift: new Array<number>(FINGERS).fill(0),
  touch: new Array<number>(FINGERS).fill(0),
  sweep: new Array<number>(FINGERS).fill(0),
})

function writeHand(pose: HandPose, tracks: HandTracks, t: number, carry: number): void {
  pose.rock = sample(tracks.rock, t)
  pose.carry = sample(tracks.carry, t) + carry
  pose.open = sample(tracks.open, t)
  pose.away = sample(tracks.away, t)
  for (let f = 0; f < FINGERS; f++) {
    pose.lift[f] = sample(tracks.lift[f], t)
    pose.touch[f] = sample(tracks.touch[f], t)
    pose.sweep[f] = sample(tracks.sweep[f], t)
  }
}

/**
 * The loop: the cube starts scrambled, the hands solve it, one hand shakes it, and it
 * is scrambled again. It keeps time only while it advances, so it rests with the page
 * when the section is off screen.
 */
export function createTimeline(cube: Cubie[], options: { seed: number }): Timeline {
  let seed = options.seed
  let solve = solveOps(seed)
  for (const op of invertOps(solve)) applyOp(cube, op)

  let stage: Stage = "solving"
  let plan = planSolve(solve, tracksFrom(), seed)
  let index = 0
  let clock = 0
  let elapsed = 0

  const turn = { axis: 0 as Axis, coord: 0, angle: 0 }
  const pose: Pose = {
    hands: [handPose(), handPose()],
    yaw: 0,
    pitch: 0,
    roll: 0,
    shake: 0,
    shakePhase: 0,
    turn: null,
    glow: 0,
  }

  const startStage = (next: Stage) => {
    stage = next
    index = 0
    if (next === "solved") {
      plan = planSolved(plan.tracks)
    } else if (next === "changed") {
      seed += 1
      solve = solveOps(seed)
      plan = planShake(invertOps(solve), plan.tracks)
    } else {
      plan = planSolve(solve, plan.tracks, seed)
    }
  }

  const setPose = () => {
    const { tracks } = plan
    const t = clock
    const timedOp = plan.ops[index]
    const running = timedOp && t >= timedOp.start ? timedOp : null
    let angle = 0
    pose.turn = null
    if (running) {
      const { axis, coord, sign } = opLayer(running.op)
      angle = sign * QUARTER * turnCurve((t - running.start) / (running.end - running.start))
      turn.axis = axis
      turn.coord = coord
      turn.angle = angle
      pose.turn = turn
    }
    writeHand(pose.hands[0], tracks.hands[0], t, running?.carrier === 0 ? angle : 0)
    writeHand(pose.hands[1], tracks.hands[1], t, running?.carrier === 1 ? angle : 0)
    pose.yaw = sample(tracks.yaw, t)
    pose.pitch = sample(tracks.pitch, t) + sample(tracks.kickPitch, t)
    pose.roll = sample(tracks.roll, t) + sample(tracks.kickRoll, t)
    pose.shake = sample(tracks.shake, t)
    pose.shakePhase = elapsed * SHAKE_RATE * Math.PI * 2
    pose.glow = stage === "solved" ? reach(t / 0.3) : stage === "changed" ? 1 - reach(t / 0.3) : 0
  }

  setPose()

  return {
    pose,
    advance(seconds) {
      clock += seconds
      elapsed += seconds
      // A long frame can finish more than one move.
      for (;;) {
        const timedOp = plan.ops[index]
        if (timedOp) {
          if (clock < timedOp.end) break
          applyOp(cube, timedOp.op)
          index += 1
          continue
        }
        if (clock < plan.seconds) break
        clock -= plan.seconds
        startStage(stage === "solving" ? "solved" : stage === "solved" ? "changed" : "solving")
      }
      setPose()
    },
    stage: () => stage,
  }
}
