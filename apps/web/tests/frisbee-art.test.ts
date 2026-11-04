import { describe, expect, it } from "vitest"

import { seededRandom } from "~/lib/marketing/solve-art/cube"
import { buildLeg, createFrisbeeTimeline, DISC_RADIUS, heroLayout, legSeconds, PALM_FROM_DISC, SEEN_SHARE, THROWS, throwDealer, type Field, type HandIndex, type TrickName } from "~/lib/marketing/frisbee-art/flight"
import { ANIMATION_SPEED, BACK_ROLL_SECONDS, BACK_TOSS_HEIGHT, EDGE_DISTANCE, FORCE_HOLD_SECONDS, MAX_NORMAL_CATCHES, ORBIT_LAPS, ORBIT_SECONDS, REST_BETWEEN_THROWS, SCENE_SIZE, TRICK_SPIN_SECONDS } from "~/lib/marketing/frisbee-art/settings"
import { BACK_AT_WRIST, BACK_ON_FINGERS, FORCE_PALM_DISTANCE, ORBIT_ENTRY_SECONDS, ORBIT_PALM_SHIFT, TRICK_NAMES } from "~/lib/marketing/frisbee-art/tricks"
import { ARM_FADE_FAR, backHeight, closedTargets, createFrisbeeScene, elbowAt, frisbeeHand, gripFrame, handFrame, handTargets, pointFingers, SIDES } from "~/lib/marketing/frisbee-art/scene"
import { rigid, transformPoint, type Rigid } from "~/lib/marketing/solve-art/math"
import { drawHand, MATERIAL, type PartSink } from "~/lib/marketing/solve-art/rig"
import { handRig } from "~/lib/marketing/solve-art/scene"

const FIELD: Field = heroLayout(2527, 845, 664).field
const STEP = 1 / 240
const SECONDS = 60

type Timeline = ReturnType<typeof createFrisbeeTimeline>

function eachStep(check: (timeline: Timeline, step: number) => void, seconds = SECONDS, step = STEP): void {
  const timeline = createFrisbeeTimeline({ seed: 7 })
  for (let i = 0; i < seconds / step; i++) {
    timeline.advance(step)
    timeline.write(FIELD)
    check(timeline, i)
  }
}

describe("the throws", () => {
  it("has at least four different throws", () => {
    expect(THROWS.length).toBeGreaterThanOrEqual(4)
    expect(new Set(THROWS.map((spec) => spec.name)).size).toBe(THROWS.length)
  })

  it("never deals the same throw twice in a row, and deals each throw in each round", () => {
    const deal = throwDealer(seededRandom(3))
    let previous = -1
    const seen: number[] = []
    for (let i = 0; i < 2000; i++) {
      const next = deal()
      expect(next).not.toBe(previous)
      previous = next
      seen.push(next)
    }
    for (let i = 0; i + THROWS.length * 2 < seen.length; i++) {
      expect(new Set(seen.slice(i, i + THROWS.length * 2)).size).toBe(THROWS.length)
    }
  })

  it("mirrors a throw when the other hand throws it", () => {
    for (const spec of THROWS) {
      const there = buildLeg(spec, 0, FIELD)
      const back = buildLeg(spec, 1, FIELD)
      expect(back.release[0]).toBeCloseTo(-there.release[0])
      expect(back.c1[0]).toBeCloseTo(-there.c1[0])
      expect(back.c1[1]).toBeCloseTo(there.c1[1])
      expect(back.arrive[2]).toBeCloseTo(there.arrive[2])
    }
  })
})

describe("the size on the page", () => {
  const OLD_PIXELS_PER_UNIT = (gutter: number) => Math.min(54, Math.max(18, gutter / 8.6))

  it("at size 1, is 60% smaller than the first version on a wide window", () => {
    for (const [width, gutter] of [
      [2527, 664],
      [1905, 353],
      [1728, 264],
    ]) {
      const { unit } = heroLayout(width, 845, gutter)
      expect(unit / SCENE_SIZE / OLD_PIXELS_PER_UNIT(gutter)).toBeCloseTo(0.4, 1)
    }
  })

  it("takes the size from the setting, and size 1 is the size to go back to", () => {
    // A disc 99 CSS pixels wide on a wide window, and 51 on the smallest one, at size 1.
    expect(2 * DISC_RADIUS * heroLayout(2527, 845, 664).unit).toBeCloseTo(99.4 * SCENE_SIZE, 1)
    expect(2 * DISC_RADIUS * heroLayout(1425, 845, 113).unit).toBeCloseTo(50.6 * SCENE_SIZE, 1)
  })

  it("stays big enough to read on a small window", () => {
    expect(heroLayout(1425, 845, 113).unit).toBeGreaterThanOrEqual(11 * SCENE_SIZE)
  })

  it("keeps the hands in the same place on the page at any size", () => {
    // The distance from the side of the page to the palm, in CSS pixels, at a size of 1.
    const { field, edge, unit } = heroLayout(2527, 845, 664)
    const palm = (edge - (field.span + DISC_RADIUS + PALM_FROM_DISC)) * unit
    expect(palm).toBeGreaterThan(220)
    expect(palm).toBeLessThan(280)
  })

  it("keeps the arms short: each one sinks into the page close to its wrist, in every pose", () => {
    const { field, edge } = heroLayout(2527, 845, 664)
    expect(ARM_FADE_FAR).toBeLessThan(10)
    expect(frisbeeHand(1).armMaterial).toBe(MATERIAL.fadingShell)
    // At rest, the arm has gone before the side of a wide hero.
    expect(field.span + DISC_RADIUS + PALM_FROM_DISC + 2 + ARM_FADE_FAR).toBeLessThan(edge)
  })

  it("puts the hands closer to the side of the page than the middle of a wide gutter, by the setting", () => {
    for (const [width, gutter] of [
      [2527, 664],
      [1905, 353],
    ]) {
      const { field, edge, unit } = heroLayout(width, 845, gutter)
      const gutterUnits = gutter / unit
      const middle = edge - gutterUnits + Math.max(0, (gutterUnits - 16.3) / 2)
      const before = edge - (middle + DISC_RADIUS + PALM_FROM_DISC)
      const now = edge - (field.span + DISC_RADIUS + PALM_FROM_DISC)
      expect(now).toBeCloseTo(before * EDGE_DISTANCE)
    }
  })

  it("keeps a palm on the page on a small window", () => {
    const { field, edge } = heroLayout(1425, 845, 113)
    expect(edge - (field.span + DISC_RADIUS + PALM_FROM_DISC)).toBeGreaterThan(3)
  })
})

describe("the speed", () => {
  it("takes the setting: half the speed takes twice as long", () => {
    const seconds = (speed: number) => {
      const timeline = createFrisbeeTimeline({ seed: 7, speed })
      let t = 0
      while (timeline.current().count === 0) {
        timeline.advance(1 / 240)
        t += 1 / 240
      }
      return t
    }
    expect(seconds(0.5)).toBeCloseTo(seconds(1) * 2, 1)
  })

  it("runs the scene at the speed in the settings", () => {
    const scene = createFrisbeeScene({ seed: 7 })
    scene.setField(FIELD)
    const twin = createFrisbeeTimeline({ seed: 7, speed: ANIMATION_SPEED })
    for (let i = 0; i < 90; i++) {
      scene.update(1 / 60)
      twin.advance(1 / 60)
    }
    twin.write(FIELD)
    let first: Rigid | null = null
    const sink: PartSink = {
      box() {},
      cylinder(m) {
        first ??= Float32Array.from(m)
      },
    }
    scene.draw(sink, new Float32Array(48))
    const disc = first as unknown as Rigid
    expect(disc[3]).toBeCloseTo(twin.disc.x)
    expect(disc[7]).toBeCloseTo(twin.disc.y)
    expect(disc[11]).toBeCloseTo(twin.disc.z)
  })
})

describe("the game", () => {
  it("throws quickly once a hand starts its swing", () => {
    for (const spec of THROWS) {
      expect(spec.seconds).toBeLessThan(1.2)
      expect(legSeconds(spec) - REST_BETWEEN_THROWS).toBeLessThan(2.1)
    }
  })

  it("waits between throws: the disc stays in the hand for the rest time, and it barely moves", () => {
    let count = -1
    let started = 0
    let t = 0
    let from = [0, 0, 0]
    let checked = 0
    eachStep((timeline, step) => {
      t = step * STEP
      const { disc } = timeline
      if (timeline.current().count !== count) {
        count = timeline.current().count
        started = t
        from = [disc.x, disc.y, disc.z]
      }
      if (t - started < REST_BETWEEN_THROWS) {
        checked += 1
        expect(disc.flying).toBe(false)
        expect(Math.hypot(disc.x - from[0], disc.y - from[1], disc.z - from[2])).toBeLessThan(0.35)
      }
    })
    expect(checked * STEP).toBeGreaterThan(REST_BETWEEN_THROWS * 10)
  })

  it("flies the disc for the time of its throw, and no longer", () => {
    const flying = new Map<number, { seconds: number; want: number }>()
    eachStep((timeline) => {
      if (!timeline.disc.flying) return
      const { count, spec } = timeline.current()
      const flight = flying.get(count) ?? { seconds: 0, want: spec.seconds }
      flight.seconds += STEP
      flying.set(count, flight)
    })
    const finished = [...flying.values()].slice(0, -1)
    expect(finished.length).toBeGreaterThan(10)
    for (const flight of finished) expect(flight.seconds).toBeCloseTo(flight.want, 1)
  })

  it("alternates the hands, and each throw differs from the one before", () => {
    const legs: { name: string; thrower: HandIndex }[] = []
    eachStep((timeline) => {
      const { spec, thrower, count } = timeline.current()
      if (legs.length === count) legs.push({ name: spec.name, thrower })
    })
    expect(legs.length).toBeGreaterThan(10)
    legs.forEach((leg, i) => {
      if (i === 0) return
      expect(leg.thrower).not.toBe(legs[i - 1].thrower)
      expect(leg.name).not.toBe(legs[i - 1].name)
    })
  })

  it("flies the disc on one smooth path on any window: no jump and no kink, at a release, a catch or a new throw", () => {
    // In CSS pixels a second, because a small window or a small scene covers more world units in the same flight.
    const MOST_SPEED = 3700
    const MOST_KINK = 400
    for (const [width, gutter] of [
      [2527, 664],
      [1905, 340],
      [1425, 113],
    ]) {
      const { field, unit } = heroLayout(width, 845, gutter)
      for (const seed of [7, 21]) {
        const timeline = createFrisbeeTimeline({ seed })
        let last: number[] | null = null
        let lastVelocity: number[] | null = null
        for (let i = 0; i < SECONDS / STEP; i++) {
          timeline.advance(STEP)
          timeline.write(field)
          const now = [timeline.disc.x, timeline.disc.y, timeline.disc.z]
          if (last) {
            const velocity = now.map((v, k) => (v - (last as number[])[k]) / STEP)
            expect(Math.hypot(...velocity) * unit).toBeLessThan(MOST_SPEED)
            if (lastVelocity) expect(Math.hypot(...velocity.map((v, k) => v - (lastVelocity as number[])[k])) * unit).toBeLessThan(MOST_KINK)
            lastVelocity = velocity
          }
          last = now
        }
      }
    }
  })

  it("slows the disc in the air", () => {
    const flights = new Map<number, { x: number; y: number; z: number }[]>()
    eachStep((timeline) => {
      const { disc } = timeline
      if (!disc.flying) return
      const { count } = timeline.current()
      if (!flights.has(count)) flights.set(count, [])
      flights.get(count)?.push({ x: disc.x, y: disc.y, z: disc.z })
    })
    expect(flights.size).toBeGreaterThan(10)
    for (const path of flights.values()) {
      const length = (from: number, to: number) => {
        let sum = 0
        for (let i = from + 1; i < to; i++) sum += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z)
        return sum
      }
      const half = Math.floor(path.length / 2)
      expect(length(0, half)).toBeGreaterThan(length(half, path.length))
    }
  })

  it("keeps the disc inside the hero", () => {
    eachStep(({ disc }) => {
      expect(Math.abs(disc.y)).toBeLessThan(FIELD.top - DISC_RADIUS / 2)
      expect(Math.abs(disc.x)).toBeLessThan(FIELD.span + 12)
    })
  })

  it("always has the disc in one closed hand or in the air", () => {
    let flying = 0
    let held = 0
    eachStep(({ disc, hands }) => {
      if (disc.flying) {
        flying += 1
        return
      }
      // The trick has its own test.
      if (disc.balancing) return
      held += 1
      const holders = hands.filter((hand) => Math.hypot(hand.x - disc.x, hand.y - disc.y, hand.z - disc.z) < 0.02)
      expect(holders).toHaveLength(1)
      // The catch closes the fingers in its first moments.
      expect(holders[0].open).toBeLessThan(0.97)
    })
    expect(flying).toBeGreaterThan(0)
    expect(held).toBeGreaterThan(0)
  })

  it("opens the hand that throws, and the hand that catches stays open until the disc comes", () => {
    eachStep((timeline) => {
      const { disc, hands } = timeline
      if (!disc.flying) return
      const { thrower, spec } = timeline.current()
      const catcher = hands[thrower === 0 ? 1 : 0]
      const left = Math.hypot(catcher.x - disc.x, catcher.y - disc.y, catcher.z - disc.z)
      if (left > 2) expect(catcher.open).toBeGreaterThan(0.6)
      expect(spec.seconds).toBeGreaterThan(0.7)
    })
  })

  it("keeps each hand on its own side, with its palm out of the content on a wide window", () => {
    const palm = 4.45
    const { edge, unit } = heroLayout(2527, 845, 664)
    const rail = edge - 664 / unit
    eachStep(({ hands }) => {
      hands.forEach((hand, h) => {
        expect(Math.sign(hand.x)).toBe(SIDES[h])
        expect(Math.abs(hand.x) + palm).toBeGreaterThan(rail)
      })
    })
  })

  it("stays correct after one very long frame and a new size of the hero", () => {
    const timeline = createFrisbeeTimeline({ seed: 7 })
    timeline.advance(10_000)
    timeline.write({ span: 30, top: 22, depth: 2.2, floor: -22, inner: 31, edge: 64 })
    expect(Number.isFinite(timeline.disc.x)).toBe(true)
    expect(Number.isFinite(timeline.hands[0].x)).toBe(true)
  })
})

describe("the finger spin trick", () => {
  /** Runs many catches, and gives each frame of a trick to `check`, with the hand that catches. */
  function eachTrickFrame(check: (timeline: Timeline, catcher: HandIndex, on: number) => void, seconds = 180): void {
    let leg = -1
    let started = 0
    eachStep((timeline, step) => {
      const { disc } = timeline
      const { count, thrower, trick } = timeline.current()
      if (trick !== "spin" || !disc.balancing) return
      if (count !== leg) {
        leg = count
        started = step
      }
      check(timeline, thrower === 0 ? 1 : 0, (step - started) * STEP)
    }, seconds)
  }

  /** The catches of a long game: the trick of each one, or null for a normal catch. */
  function catchesOf(seed: number, count: number): (TrickName | null)[] {
    const timeline = createFrisbeeTimeline({ seed })
    const out: (TrickName | null)[] = []
    while (out.length < count) {
      const now = timeline.current()
      if (out.length === now.count) out.push(now.trick)
      timeline.advance(0.05)
    }
    return out
  }

  it("never gives two normal catches in a row, for every visit", () => {
    for (let seed = 0; seed < 200; seed++) {
      let normals = 0
      for (const trick of catchesOf(seed, 120)) {
        normals = trick ? 0 : normals + 1
        expect(normals, `seed ${seed}`).toBeLessThanOrEqual(MAX_NORMAL_CATCHES)
      }
    }
    expect(MAX_NORMAL_CATCHES).toBeLessThanOrEqual(1)
  })

  it("stays random: most catches are tricks, some are not, and tricks can come in a row", () => {
    let tricks = 0
    let catches = 0
    let inARow = 0
    let normals = 0
    for (let seed = 0; seed < 50; seed++) {
      const list = catchesOf(seed, 120)
      list.forEach((trick, i) => {
        catches += 1
        if (trick) {
          tricks += 1
          if (i > 0 && list[i - 1]) inARow += 1
        } else {
          normals += 1
        }
      })
    }
    expect(tricks / catches).toBeGreaterThan(0.6)
    expect(tricks / catches).toBeLessThan(0.75)
    expect(inARow).toBeGreaterThan(0)
    expect(normals).toBeGreaterThan(0)
  })

  it("uses all the tricks, and a trick differs from the trick before it", () => {
    const tricks: TrickName[] = []
    let last = -1
    eachStep((timeline) => {
      const { count, trick } = timeline.current()
      if (count !== last) {
        last = count
        if (trick) tricks.push(trick)
      }
    }, 500)
    expect(new Set(tricks)).toEqual(new Set(TRICK_NAMES))
    tricks.forEach((trick, i) => {
      if (i > 0) expect(trick).not.toBe(tricks[i - 1])
    })
  })

  it("makes the same order of tricks for each visit, and a different order for another seed", () => {
    const order = (seed: number) => {
      const timeline = createFrisbeeTimeline({ seed })
      const out: (TrickName | null)[] = []
      for (let i = 0; i < 240 * 200; i++) {
        timeline.advance(STEP)
        const { count, trick } = timeline.current()
        if (out.length === count) out.push(trick)
      }
      return out
    }
    expect(order(7)).toEqual(order(7))
    expect(order(7)).not.toEqual(order(9))
  })

  it("lasts as long as the setting, and takes longer than a normal catch", () => {
    for (const spec of THROWS) {
      expect(legSeconds(spec, "spin") - legSeconds(spec)).toBeGreaterThan(TRICK_SPIN_SECONDS)
    }
  })

  it("stands the hand up under the disc, and keeps the disc flat and spinning on the fingertip", () => {
    let seen = 0
    let spin = 0
    eachTrickFrame(({ disc, hands }, catcher, on) => {
      const hand = hands[catcher]
      // After the disc has settled, and before the pop.
      if (on < 0.8 || on > 0.6 + TRICK_SPIN_SECONDS) return
      seen += 1
      expect(hand.point).toBe(1)
      expect(Math.abs(hand.nose)).toBeGreaterThan(1.4)
      expect(Math.sign(hand.nose)).toBe(-SIDES[catcher])
      expect(Math.abs(disc.bank)).toBeLessThan(0.4)
      expect(Math.abs(disc.nose)).toBeLessThan(0.2)
      expect(Math.hypot(hand.x - disc.x, hand.y - disc.y, hand.z - disc.z)).toBeLessThan(0.001)
      if (spin !== 0) expect(Math.abs(disc.spin - spin)).toBeGreaterThan(0.01)
      spin = disc.spin
    })
    expect(seen * STEP).toBeGreaterThan(TRICK_SPIN_SECONDS * 2.5)
  })

  it("puts the raised index under the center of the disc", () => {
    for (const h of [0, 1] as HandIndex[]) {
      const s = SIDES[h]
      const rig = frisbeeHand(s)
      const grip = gripFrame(s)
      const pose = { x: 3, y: 2, z: 1, bank: 0.1, nose: -s * (Math.PI / 2), wrist: 0, open: 1, point: 1, gap: 0, flat: 0, slide: 0, along: 0, stand: 0, glow: 0, roll: 0, push: 0, claw: 0, clench: 0 }
      const frame = handFrame(rigid(), pose, grip)
      const targets = new Float32Array(15)
      handTargets(targets, rig, closedTargets(s, grip), 1)
      pointFingers(targets, rig, frame, pose)
      const tips = new Float32Array(15)
      drawHand({ box() {}, cylinder() {} }, rig, frame, targets, 1, tips, 0)
      expect(Math.hypot(tips[0] - pose.x, tips[1] - (pose.y - 0.26), tips[2] - pose.z), `hand ${h}`).toBeLessThan(0.08)
      // The other fingers make a fist, below the raised fingertip.
      for (let f = 1; f < 5; f++) expect(tips[f * 3 + 1]).toBeLessThan(pose.y - 2)
    }
  })

  it("ends in a normal grip, so the next throw starts from the same place", () => {
    let last: { open: number; point: number; nose: number; wrist: number } | null = null
    let ended = 0
    let was = false
    eachStep(({ disc, hands }) => {
      if (was && !disc.balancing && last) {
        ended += 1
        expect(last.open).toBeLessThan(0.02)
        expect(last.point).toBeLessThan(0.001)
        expect(Math.abs(last.nose)).toBeLessThan(0.01)
      }
      was = disc.balancing
      if (disc.balancing) {
        const hand = hands.reduce((near, next) => (Math.abs(next.x - disc.x) < Math.abs(near.x - disc.x) ? next : near))
        last = { open: hand.open, point: hand.point, nose: hand.nose, wrist: hand.wrist }
      }
    }, 120)
    expect(ended).toBeGreaterThan(1)
  })
})

describe("the back roll trick", () => {
  /** Gives each frame of a back roll to `check`, with the hand that catches and the seconds since the disc arrived. */
  function eachRollFrame(check: (timeline: Timeline, catcher: HandIndex, on: number, leg: number) => void, seconds = 300): void {
    let leg = -1
    let started = 0
    eachStep((timeline, step) => {
      const { count, thrower, trick } = timeline.current()
      if (trick !== "backRoll" || !timeline.disc.balancing) return
      if (count !== leg) {
        leg = count
        started = step
      }
      check(timeline, thrower === 0 ? 1 : 0, (step - started) * STEP, count)
    }, seconds)
  }

  it("takes the disc softly: it arrives slower than in a normal throw", () => {
    for (const spec of THROWS) {
      const normal = buildLeg(spec, 0, FIELD)
      const soft = buildLeg(spec, 0, FIELD, "backRoll")
      expect(Math.hypot(...soft.come)).toBeLessThan(Math.hypot(...normal.come))
      expect(Math.hypot(...soft.come)).toBeLessThan(22)
      expect(soft.arrive).toEqual(normal.arrive)
    }
  })

  it("keeps the disc on the back of the hand as it slides from the fingers to the wrist", () => {
    let seen = 0
    const wherePerRoll = new Map<number, number[]>()
    eachRollFrame(({ disc, hands }, catcher, on, leg) => {
      const hand = hands[catcher]
      if (on > BACK_ROLL_SECONDS) return
      seen += 1
      expect(hand.flat).toBe(1)
      expect(hand.slide).toBe(1)
      // The hand holds the disc at the place `along` on its back.
      const frame = handFrame(rigid(), hand, gripFrame(SIDES[catcher]))
      const onHand = transformPoint(frame, 0, backHeight(hand.along), hand.along)
      expect(Math.hypot(onHand[0] - disc.x, onHand[1] - disc.y, onHand[2] - disc.z)).toBeLessThan(0.001)
      // The back of the hand faces up.
      const backUp = frame[5]
      expect(backUp).toBeGreaterThan(0.85)
      // The disc is above the middle of the hand and not below it.
      const list = wherePerRoll.get(leg) ?? []
      list.push(hand.along)
      wherePerRoll.set(leg, list)
    })
    expect(seen * STEP).toBeGreaterThan(BACK_ROLL_SECONDS * 2)
    for (const list of wherePerRoll.values()) {
      expect(list[0]).toBeCloseTo(BACK_ON_FINGERS, 0)
      expect(list.at(-1) as number).toBeCloseTo(BACK_AT_WRIST, 0)
      list.forEach((along, i) => {
        if (i > 0) expect(along).toBeLessThanOrEqual(list[i - 1] + 1e-6)
      })
    }
  })

  it("tosses the disc up by the setting, and it comes down into the hand", () => {
    const rolls = new Map<number, { high: number; start: number; end: number }>()
    eachRollFrame(({ disc }, _catcher, on, leg) => {
      const roll = rolls.get(leg) ?? { high: -Infinity, start: 0, end: 0 }
      if (on > BACK_ROLL_SECONDS && on < BACK_ROLL_SECONDS + 0.16) roll.start = disc.y
      roll.high = Math.max(roll.high, disc.y)
      roll.end = disc.y
      rolls.set(leg, roll)
    })
    expect(rolls.size).toBeGreaterThan(1)
    for (const roll of rolls.values()) {
      expect(roll.high - roll.start).toBeGreaterThan(BACK_TOSS_HEIGHT * 0.8)
      // It comes down again, to the place of rest. A throw that arrives low starts its toss below that place.
      expect(roll.high - roll.end).toBeGreaterThan(BACK_TOSS_HEIGHT * 0.5)
    }
  })

  it("ends in a normal grip at the place of rest", () => {
    let was = false
    let ended = 0
    let held = { open: 1, flat: 1, slide: 1, point: 1 }
    eachStep((timeline) => {
      const { disc, hands } = timeline
      const { trick } = timeline.current()
      if (was && !disc.balancing) {
        ended += 1
        expect(held.open).toBeLessThan(0.02)
        expect(held.flat).toBeLessThan(0.001)
        expect(held.slide).toBeLessThan(0.001)
        expect(held.point).toBeLessThan(0.001)
      }
      was = disc.balancing
      if (disc.balancing && trick) {
        const hand = hands.reduce((near, next) => (Math.abs(next.x - disc.x) < Math.abs(near.x - disc.x) ? next : near))
        held = { open: hand.open, flat: hand.flat, slide: hand.slide, point: hand.point }
      }
    }, 200)
    expect(ended).toBeGreaterThan(4)
  })
})

describe("the magnetic orbit trick", () => {
  /** Gives each frame of an orbit to `check`, with the hand that catches and the seconds since the disc arrived. */
  function eachOrbitFrame(check: (timeline: Timeline, catcher: HandIndex, on: number, leg: number) => void, seconds = 300): void {
    let leg = -1
    let started = 0
    eachStep((timeline, step) => {
      const { count, thrower, trick } = timeline.current()
      if (trick !== "orbit" || !timeline.disc.balancing) return
      if (count !== leg) {
        leg = count
        started = step
      }
      check(timeline, thrower === 0 ? 1 : 0, (step - started) * STEP, count)
    }, seconds)
  }

  const ENTRY = ORBIT_ENTRY_SECONDS

  it("never touches the hand while the disc circles it", () => {
    let seen = 0
    eachOrbitFrame(({ disc, hands }, catcher, on) => {
      if (on < ENTRY || on > ENTRY + ORBIT_SECONDS) return
      seen += 1
      const hand = hands[catcher]
      // The ring goes around the palm. It tightens at the end, and it still keeps the rim of the disc off the fingers.
      const palmX = hand.x - SIDES[catcher] * ORBIT_PALM_SHIFT
      const off = Math.hypot(disc.x - palmX, (disc.z - hand.z) / 1.7)
      expect(off).toBeGreaterThan(DISC_RADIUS)
      expect(hand.stand).toBe(1)
      expect(hand.open).toBe(1)
    })
    expect(seen * STEP).toBeGreaterThan(ORBIT_SECONDS)
  })

  it("goes around the hand the number of laps in the settings, in front of it and behind it, and speeds up", () => {
    const orbits = new Map<number, { turned: number; last: number | null; near: number; far: number; first: number; second: number; n: number }>()
    eachOrbitFrame(({ disc, hands }, catcher, on, leg) => {
      if (on < ENTRY || on > ENTRY + ORBIT_SECONDS) return
      const hand = hands[catcher]
      const orbit = orbits.get(leg) ?? { turned: 0, last: null, near: 0, far: 0, first: 0, second: 0, n: 0 }
      const angle = Math.atan2(disc.z - hand.z, disc.x - (hand.x - SIDES[catcher] * ORBIT_PALM_SHIFT))
      if (orbit.last !== null) {
        let step = angle - orbit.last
        if (step > Math.PI) step -= Math.PI * 2
        if (step < -Math.PI) step += Math.PI * 2
        orbit.turned += Math.abs(step)
        if (on < ENTRY + ORBIT_SECONDS / 2) orbit.first += Math.abs(step)
        else orbit.second += Math.abs(step)
      }
      orbit.last = angle
      orbit.near = Math.max(orbit.near, disc.z - hand.z)
      orbit.far = Math.min(orbit.far, disc.z - hand.z)
      orbits.set(leg, orbit)
    })
    expect(orbits.size).toBeGreaterThan(1)
    for (const orbit of orbits.values()) {
      expect(orbit.turned).toBeGreaterThan(Math.PI * 2 * ORBIT_LAPS)
      expect(orbit.near).toBeGreaterThan(4)
      expect(orbit.far).toBeLessThan(-4)
      expect(orbit.second).toBeGreaterThan(orbit.first * 1.3)
    }
  })

  it("lights the hand up as the disc speeds up", () => {
    let early = 0
    let late = 0
    eachOrbitFrame(({ hands }, catcher, on) => {
      if (on > ENTRY && on < ENTRY + 0.3) early = Math.max(early, hands[catcher].glow)
      if (on > ENTRY + ORBIT_SECONDS - 0.1 && on < ENTRY + ORBIT_SECONDS) late = Math.max(late, hands[catcher].glow)
    })
    expect(late).toBeGreaterThan(0.95)
    expect(early).toBeLessThan(0.3)
  })

  it("snatches the disc into a normal grip at the place of rest", () => {
    let was = false
    let ended = 0
    let held = { open: 1, stand: 1, glow: 1, near: 9 }
    eachStep((timeline) => {
      const { disc, hands } = timeline
      const { trick } = timeline.current()
      if (was && !disc.balancing) {
        ended += 1
        expect(held.open).toBeLessThan(0.02)
        expect(held.stand).toBeLessThan(0.001)
        expect(held.glow).toBeLessThan(0.001)
        expect(held.near).toBeLessThan(0.001)
      }
      was = disc.balancing && trick === "orbit"
      if (was) {
        const hand = hands.reduce((near, next) => (Math.abs(next.x - disc.x) < Math.abs(near.x - disc.x) ? next : near))
        held = { open: hand.open, stand: hand.stand, glow: hand.glow, near: Math.hypot(hand.x - disc.x, hand.y - disc.y, hand.z - disc.z) }
      }
    }, 300)
    expect(ended).toBeGreaterThan(1)
  })

  it("keeps the disc inside the hero", () => {
    eachOrbitFrame(({ disc }) => {
      expect(Math.abs(disc.y)).toBeLessThan(FIELD.top)
      expect(Math.abs(disc.x)).toBeLessThan(heroLayout(2527, 845, 664).edge)
    })
  })
})

describe("the Force trick", () => {
  /** Gives each frame of a Force trick to `check`, with the hand that catches and the seconds since the disc arrived. */
  function eachForceFrame(check: (timeline: Timeline, catcher: HandIndex, on: number, leg: number) => void, seconds = 240): void {
    let leg = -1
    let started = 0
    eachStep((timeline, step) => {
      const { count, thrower, trick } = timeline.current()
      if (trick !== "force" || !timeline.disc.balancing) return
      if (count !== leg) {
        leg = count
        started = step
      }
      check(timeline, thrower === 0 ? 1 : 0, (step - started) * STEP, count)
    }, seconds)
  }
  const STOP = 0.28

  it("stops the disc in the air and leaves it floating, with no hand on it", () => {
    let seen = 0
    const start = new Map<number, number[]>()
    eachForceFrame(({ disc, hands }, catcher, on, leg) => {
      if (on < STOP + 0.2 || on > STOP + FORCE_HOLD_SECONDS) return
      seen += 1
      const from = start.get(leg) ?? [disc.x, disc.y, disc.z]
      start.set(leg, from)
      // It stays near one place.
      expect(Math.hypot(disc.x - from[0], disc.y - from[1], disc.z - from[2])).toBeLessThan(1.2)
      // The palm stays well away from it.
      const frame = handFrame(rigid(), hands[catcher], gripFrame(SIDES[catcher]))
      const gap = Math.hypot(frame[3] - disc.x, frame[7] - disc.y, frame[11] - disc.z)
      expect(gap).toBeGreaterThan(FORCE_PALM_DISTANCE - 1.5)
      expect(hands[catcher].open).toBe(1)
    })
    expect(seen * STEP).toBeGreaterThan(FORCE_HOLD_SECONDS)
  })

  it("raises the hand with its fingers up, and points the palm at the disc", () => {
    let seen = 0
    eachForceFrame(({ disc, hands }, catcher, on) => {
      if (on < STOP || on > STOP + FORCE_HOLD_SECONDS) return
      seen += 1
      const hand = hands[catcher]
      const frame = handFrame(rigid(), hand, gripFrame(SIDES[catcher]))
      // The fingers point up.
      expect(frame[6]).toBeGreaterThan(0.85)
      // The palm side of the hand looks at the disc. In hand space, the palm faces -y.
      const lx = disc.x - frame[3]
      const ly = disc.y - frame[7]
      const lz = disc.z - frame[11]
      const l = Math.hypot(lx, ly, lz)
      const facing = -(frame[1] * lx + frame[5] * ly + frame[9] * lz) / l
      expect(facing).toBeGreaterThan(0.6)
      expect(hand.push).toBeCloseTo(1)
    })
    expect(seen).toBeGreaterThan(0)
  })

  it("ends in a normal grip at the place of rest", () => {
    let was = false
    let ended = 0
    let held = { open: 1, roll: 1, push: 1, stand: 1, near: 9 }
    eachStep((timeline) => {
      const { disc, hands } = timeline
      const { trick } = timeline.current()
      if (was && !disc.balancing) {
        ended += 1
        expect(held.open).toBeLessThan(0.02)
        expect(Math.abs(held.roll)).toBeLessThan(0.01)
        expect(held.push).toBeLessThan(0.001)
        expect(held.stand).toBeLessThan(0.01)
        expect(held.near).toBeLessThan(0.02)
      }
      was = disc.balancing && trick === "force"
      if (was) {
        const hand = hands.reduce((near, next) => (Math.abs(next.x - disc.x) < Math.abs(near.x - disc.x) ? next : near))
        held = { open: hand.open, roll: hand.roll, push: hand.push, stand: hand.stand, near: Math.hypot(hand.x - disc.x, hand.y - disc.y, hand.z - disc.z) }
      }
    }, 240)
    expect(ended).toBeGreaterThan(1)
  })
})

describe("the rest between throws", () => {
  const SEEDS = [1, 7, 42, 99, 1234]

  it("is there while a hand waits, and in no other part of a throw", () => {
    for (const seed of SEEDS) {
      const timeline = createFrisbeeTimeline({ seed })
      let t = 0
      while (timeline.current().count < 12) {
        const start = timeline.current().count
        timeline.advance(1 / 120)
        t = timeline.current().count === start ? t + 1 / 120 : 0
        timeline.write(FIELD)
        const rest = timeline.secondsToRest() === 0
        if (t < REST_BETWEEN_THROWS - 1 / 60) expect(rest).toBe(true)
        if (t > REST_BETWEEN_THROWS + 1 / 60) expect(rest).toBe(false)
        if (rest) {
          expect(timeline.disc.flying).toBe(false)
          expect(timeline.disc.balancing).toBe(false)
        }
      }
    }
  })

  it("comes in the seconds it says, at any time and any speed", () => {
    for (const speed of [1, 0.6, 1.5]) {
      for (const seed of SEEDS) {
        const timeline = createFrisbeeTimeline({ seed, speed })
        for (let i = 0; i < 400; i++) {
          timeline.advance(0.037)
          const said = timeline.secondsToRest()
          if (said === 0) continue
          const twin = createFrisbeeTimeline({ seed, speed })
          for (let k = 0; k <= i; k++) twin.advance(0.037)
          expect(twin.secondsToRest()).toBe(said)
          const count = twin.current().count
          twin.advance(said)
          // One step takes the art to a hand that waits, for all throws and all tricks.
          expect(twin.secondsToRest()).toBe(0)
          expect(twin.current().count).toBe(count + 1)
          twin.write(FIELD)
          expect(twin.disc.flying).toBe(false)
          expect(twin.disc.balancing).toBe(false)
        }
      }
    }
  })

  it("is the same moment after small steps and after one jump", () => {
    const small = createFrisbeeTimeline({ seed: 7 })
    const jump = createFrisbeeTimeline({ seed: 7 })
    while (small.current().count === 0 && small.secondsToRest() === 0) {
      small.advance(1 / 60)
      jump.advance(1 / 60)
    }
    jump.advance(jump.secondsToRest())
    while (small.secondsToRest() > 0) small.advance(1 / 60)

    expect(small.current().count).toBe(jump.current().count)
    expect(small.current().spec.name).toBe(jump.current().spec.name)
    expect(small.current().trick).toBe(jump.current().trick)
    small.write(FIELD)
    jump.write(FIELD)
    expect(small.disc.x).toBeCloseTo(jump.disc.x, 1)
    expect(small.disc.y).toBeCloseTo(jump.disc.y, 1)
    expect(small.disc.z).toBeCloseTo(jump.disc.z, 1)
  })

  it("no hand and no disc go down into the part of the hero that counts as not seen", () => {
    // A hand is about 6 world units, and the disc is flat.
    const HAND_REACH = 3.5
    const DISC_REACH = 1
    for (const [width, height, gutter] of [
      [1425, 845, 113],
      [1905, 845, 340],
      [2527, 845, 660],
    ]) {
      const { field, unit } = heroLayout(width, height, gutter)
      for (const seed of SEEDS) {
        const timeline = createFrisbeeTimeline({ seed })
        let lowest = Infinity
        for (let i = 0; i < 3000; i++) {
          timeline.advance(1 / 60)
          timeline.write(field)
          lowest = Math.min(lowest, timeline.disc.y - DISC_REACH, timeline.hands[0].y - HAND_REACH, timeline.hands[1].y - HAND_REACH)
        }
        // The share of the hero below the lowest point.
        expect(0.5 + (lowest * unit) / height).toBeGreaterThan(SEEN_SHARE)
      }
    }
  })

  it("the scene gives it to the art loop", () => {
    const scene = createFrisbeeScene({ seed: 7 })
    expect(scene.secondsToRest()).toBe(0)
    scene.update(REST_BETWEEN_THROWS + 0.01)
    const said = scene.secondsToRest()
    expect(said).toBeGreaterThan(0)
    scene.update(said)
    expect(scene.secondsToRest()).toBe(0)
  })
})

describe("the hands", () => {
  const sink: PartSink = { box() {}, cylinder() {} }

  it("are the same hands as on the About page", () => {
    for (const s of [-1, 1] as const) {
      const about = handRig(s)
      const hero = frisbeeHand(s)
      expect(hero.fingers).toEqual(about.fingers)
      expect(hero.side).toBe(about.side)
      expect(hero.relaxed).toEqual(about.relaxed)
    }
  })

  it("turns the forearm around the elbow as the hand swings", () => {
    const elbow: [number, number, number] = [0, 0, 0]
    const rest = { x: FIELD.span + DISC_RADIUS, y: 0, z: 0, bank: 0, nose: 0, wrist: 0, open: 0, point: 0, gap: 0, flat: 0, slide: 0, along: 0, stand: 0, glow: 0, roll: 0, push: 0, claw: 0, clench: 0 }
    elbowAt(elbow, rest, 1, FIELD)
    const atRest = [...elbow]
    elbowAt(elbow, { ...rest, x: rest.x - 6 }, 1, FIELD)
    // The elbow moves with the hand, but less than the hand does.
    expect(elbow[0]).toBeLessThan(atRest[0])
    expect(atRest[0] - elbow[0]).toBeLessThan(3)
  })

  it.each([0, 1] as HandIndex[])("closes the fingers of hand %i on the disc: the thumb on top, the others under the rim", (h) => {
    const s = SIDES[h]
    const rig = frisbeeHand(s)
    const grip = gripFrame(s)
    const closed = closedTargets(s, grip)
    const targets = new Float32Array(15)
    handTargets(targets, rig, closed, 0)
    const frame = handFrame(rigid(), { x: 0, y: 0, z: 0, bank: 0, nose: 0, wrist: 0, open: 0, point: 0, gap: 0, flat: 0, slide: 0, along: 0, stand: 0, glow: 0, roll: 0, push: 0, claw: 0, clench: 0 }, grip)
    const tips = new Float32Array(15)
    drawHand(sink, rig, frame, targets, 1, tips, 0)
    for (let f = 0; f < 5; f++) {
      const want = transformPoint(frame, closed[f * 3], closed[f * 3 + 1], closed[f * 3 + 2])
      const miss = Math.hypot(tips[f * 3] - want[0], tips[f * 3 + 1] - want[1], tips[f * 3 + 2] - want[2])
      expect(miss, `finger ${f}`).toBeLessThan(0.06)
      expect(Math.hypot(tips[f * 3], tips[f * 3 + 2])).toBeLessThan(DISC_RADIUS)
      if (f === 4) expect(tips[f * 3 + 1]).toBeGreaterThan(0.15)
      else expect(tips[f * 3 + 1]).toBeLessThan(-0.15)
    }
  })

  it("mirrors one hand to the other in the grip", () => {
    const left = gripFrame(-1)
    const right = gripFrame(1)
    expect(left[3]).toBeCloseTo(-right[3])
    expect(left[7]).toBeCloseTo(right[7])
    expect(left[11]).toBeCloseTo(right[11])
  })
})
