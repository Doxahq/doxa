import { describe, expect, it } from "vitest"

import { createFrisbeeTimeline, DISC_RADIUS, heroLayout, CAMERA_ELEVATION, type Field, type FrisbeeTimeline, type HandIndex } from "~/lib/marketing/frisbee-art/flight"
import { copyPose, floorBand, launchDisc, stepDisc, WHY_SECONDS, writeWhy } from "~/lib/marketing/frisbee-art/kick"
import type { HandPose } from "~/lib/marketing/frisbee-art/motion"
import { DROP_GRAVITY, REST_BETWEEN_THROWS, WHY_JAB_SECONDS, WHY_JABS } from "~/lib/marketing/frisbee-art/settings"
import { createFrisbeeScene, gripFrame, handFrame, SIDES } from "~/lib/marketing/frisbee-art/scene"
import { orbitCamera, rigid } from "~/lib/marketing/solve-art/math"
import { MAX_BOXES, MAX_CYLINDERS } from "~/lib/marketing/solve-art/renderer"
import type { PartSink } from "~/lib/marketing/solve-art/rig"
import { createSolveScene } from "~/lib/marketing/solve-art/scene"

const LAYOUTS = [heroLayout(2527, 845, 664), heroLayout(1905, 845, 340), heroLayout(1425, 845, 113)]
const FIELD: Field = LAYOUTS[0].field
const STEP = 1 / 120
const DOWN = { x: 0, y: -1 }

const go = (timeline: FrisbeeTimeline, seconds: number, field = FIELD, each?: () => void) => {
  for (let t = 0; t < seconds; t += STEP) {
    timeline.advance(STEP)
    timeline.write(field)
    each?.()
  }
}

/** Runs until a hand holds the disc and waits with nothing else to do. Returns the seconds, or Infinity. */
const toRest = (timeline: FrisbeeTimeline, field = FIELD, each?: () => void, most = 30) => {
  for (let t = 0; t < most; t += STEP) {
    if (timeline.secondsToRest() === 0) return t
    timeline.advance(STEP)
    timeline.write(field)
    each?.()
  }
  return Infinity
}

const inHold = (seed = 7) => {
  const timeline = createFrisbeeTimeline({ seed })
  go(timeline, REST_BETWEEN_THROWS * 0.5)
  return timeline
}

describe("a kick on the hand that holds the disc", () => {
  it("drops the disc on the floor, gets angry, picks it up and throws again", () => {
    for (const hit of [DOWN, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0.7, y: -0.7 }]) {
      const timeline = inHold()
      const owner = timeline.current().thrower
      const countBefore = timeline.current().count
      timeline.kick(owner, hit.x, hit.y)
      expect(timeline.kicks().angry[owner]).toBe(true)
      expect(timeline.kicks().owner).toBe(owner)

      let lowest = Infinity
      let reachedTheFloor = false
      const seen = new Set<string>()
      const took = toRest(timeline, FIELD, () => {
        const { stage } = timeline.kicks()
        if (stage) seen.add(stage)
        lowest = Math.min(lowest, timeline.disc.y)
        if (timeline.disc.y < FIELD.floor + 0.5) reachedTheFloor = true
      })

      expect(took).toBeLessThan(6)
      expect(reachedTheFloor).toBe(true)
      expect(lowest).toBeGreaterThanOrEqual(FIELD.floor)
      expect([...seen]).toEqual(["wait", "reach", "grab", "lift"])
      expect(timeline.current().thrower).toBe(owner)
      expect(timeline.current().count).toBe(countBefore + 1)
      expect(timeline.kicks()).toEqual({ angry: [false, false], owner: null, stage: null })
      // The hand holds it again, at the place where a hand waits with the disc.
      timeline.write(FIELD)
      const hand = timeline.hands[owner]
      expect(timeline.disc.flying).toBe(false)
      expect(hand.x).toBeCloseTo(timeline.disc.x, 5)
      expect(hand.y).toBeCloseTo(timeline.disc.y, 5)
      expect(hand.open).toBe(0)
    }
  })

  it("the disc leaves the hand at once, and it falls", () => {
    const timeline = inHold()
    const owner = timeline.current().thrower
    timeline.kick(owner, 0, -1)
    expect(timeline.disc.flying).toBe(true)
    const startY = timeline.disc.y
    go(timeline, 0.45)
    expect(timeline.disc.y).toBeLessThan(startY - 8)
    expect(Math.hypot(timeline.disc.x - timeline.hands[owner].x, timeline.disc.y - timeline.hands[owner].y)).toBeGreaterThan(6)
    // The fingers do not stay closed on nothing.
    expect(timeline.hands[owner].open).toBeGreaterThan(0.5)
  })

  it("the same kick plays out the same at any frame rate", () => {
    const run = (step: number) => {
      const timeline = inHold()
      timeline.kick(timeline.current().thrower, 1, 0)
      timeline.advance(step === 0 ? 1 : 0)
      for (let t = 0; step > 0 && t < 1; t += step) timeline.advance(step)
      timeline.write(FIELD)
      return timeline.disc.x
    }
    expect(run(1 / 30)).toBeCloseTo(run(1 / 144), 0)
    expect(run(0)).toBeCloseTo(run(1 / 144), 0)
  })

  it("a kick while the disc rides a trick knocks it off", () => {
    let knocked = 0
    for (const seed of [1, 2, 3, 7, 9, 11, 42, 99]) {
      const timeline = createFrisbeeTimeline({ seed })
      for (let t = 0; t < 12; t += STEP) {
        timeline.advance(STEP)
        timeline.write(FIELD)
        if (timeline.current().trick && timeline.disc.balancing) break
      }
      go(timeline, 0.3)
      if (!timeline.disc.balancing) continue
      const catcher: HandIndex = timeline.current().thrower === 0 ? 1 : 0
      timeline.kick(catcher, 0, -1)
      expect(timeline.kicks().owner).toBe(catcher)
      expect(toRest(timeline)).toBeLessThan(6)
      expect(timeline.current().thrower).toBe(catcher)
      knocked += 1
    }
    expect(knocked).toBeGreaterThan(3)
  })
})

describe("a kick on a hand with no disc", () => {
  it("leaves the disc alone while it flies away from that hand", () => {
    const flying = (timeline: FrisbeeTimeline) => {
      while (!timeline.disc.flying) {
        timeline.advance(STEP)
        timeline.write(FIELD)
      }
      go(timeline, 0.1)
    }
    const kicked = createFrisbeeTimeline({ seed: 7 })
    const twin = createFrisbeeTimeline({ seed: 7 })
    flying(kicked)
    flying(twin)
    const thrower = kicked.current().thrower
    kicked.kick(thrower, 0, -1)
    expect(kicked.kicks().owner).toBeNull()
    expect(kicked.kicks().angry[thrower]).toBe(true)
    for (let i = 0; i < 40; i++) {
      kicked.advance(STEP)
      twin.advance(STEP)
      kicked.write(FIELD)
      twin.write(FIELD)
      expect(kicked.disc.x).toBeCloseTo(twin.disc.x, 5)
      expect(kicked.disc.y).toBeCloseTo(twin.disc.y, 5)
    }
    expect(kicked.kicks().owner).toBeNull()
  })

  it("makes the hand with the disc wait until the other hand calms down", () => {
    const timeline = inHold()
    const thrower = timeline.current().thrower
    const catcher: HandIndex = thrower === 0 ? 1 : 0
    timeline.kick(catcher, 0, -1)
    const heldAt = timeline.disc.x
    go(timeline, WHY_SECONDS - 0.05, FIELD, () => {
      expect(timeline.disc.flying).toBe(false)
      expect(timeline.disc.x).toBeCloseTo(heldAt, 5)
    })
    expect(timeline.kicks().angry[catcher]).toBe(true)
    go(timeline, 0.1)
    expect(timeline.kicks().angry[catcher]).toBe(false)
    // The game goes on: the throw comes, and the other hand can catch it.
    go(timeline, 1)
    expect(timeline.disc.flying).toBe(true)
    expect(timeline.kicks().owner).toBeNull()
  })

  it("a disc that reaches an angry hand bounces off it and falls, and that hand picks it up", () => {
    const timeline = createFrisbeeTimeline({ seed: 7 })
    while (!timeline.disc.flying) {
      timeline.advance(STEP)
      timeline.write(FIELD)
    }
    const catcher: HandIndex = timeline.current().thrower === 0 ? 1 : 0
    timeline.kick(catcher, 0, -1)
    expect(timeline.kicks().owner).toBeNull()
    let fell = false
    const took = toRest(timeline, FIELD, () => {
      if (timeline.kicks().owner === catcher && timeline.disc.y < FIELD.floor + 0.5) fell = true
    })
    expect(fell).toBe(true)
    expect(took).toBeLessThan(8)
    expect(timeline.current().thrower).toBe(catcher)
  })
})

describe("kicks at any moment", () => {
  const moments = Array.from({ length: 40 }, (_, i) => i * 0.53)

  it("always end with a hand that holds the disc, with no jump on the way", () => {
    // The fastest parts: the release of a throw, and the catch after a fumble.
    const MOST_PER_STEP_PIXELS = 56
    for (const layout of [LAYOUTS[0], LAYOUTS[2]]) {
      for (const hand of [0, 1] as HandIndex[]) {
        for (const moment of moments) {
          const timeline = createFrisbeeTimeline({ seed: 13 })
          timeline.write(layout.field)
          go(timeline, moment, layout.field)
          timeline.kick(hand, 0.6, -0.8)
          // A kick is a jump in speed only, so the first frame is no different from the others.
          let last = [timeline.disc.x, timeline.disc.y, timeline.hands[0].x, timeline.hands[0].y, timeline.hands[1].x, timeline.hands[1].y]
          const took = toRest(timeline, layout.field, () => {
            const now = [timeline.disc.x, timeline.disc.y, timeline.hands[0].x, timeline.hands[0].y, timeline.hands[1].x, timeline.hands[1].y]
            const worst = Math.max(...now.map((v, i) => Math.abs(v - last[i])))
            expect(worst).toBeLessThan((MOST_PER_STEP_PIXELS) / layout.unit)
            expect(Number.isFinite(worst)).toBe(true)
            last = now
          })
          expect(took).toBeLessThan(12)
          expect(timeline.disc.flying).toBe(false)
          expect(timeline.disc.y).toBeGreaterThanOrEqual(layout.field.floor)
        }
      }
    }
  })

  it("a visitor who clicks like mad cannot break it", () => {
    const timeline = createFrisbeeTimeline({ seed: 3 })
    for (let i = 0; i < 200; i++) {
      go(timeline, 0.07)
      timeline.kick((i % 3 === 0 ? 1 : 0) as HandIndex, Math.cos(i), Math.sin(i))
      expect(timeline.disc.y).toBeGreaterThanOrEqual(FIELD.floor)
      expect(Number.isFinite(timeline.hands[0].x + timeline.hands[1].x + timeline.disc.x)).toBe(true)
    }
    expect(toRest(timeline)).toBeLessThan(12)
  })

  it("both hands can be angry at the same time", () => {
    const timeline = inHold()
    timeline.kick(0, 0, -1)
    timeline.kick(1, 0, -1)
    expect(timeline.kicks().angry).toEqual([true, true])
    expect(toRest(timeline)).toBeLessThan(8)
  })

  it("finishes at the settings speed as well", () => {
    for (const speed of [0.6, 1.5]) {
      const timeline = createFrisbeeTimeline({ seed: 7, speed })
      go(timeline, 0.4)
      timeline.kick(timeline.current().thrower, 0, -1)
      expect(toRest(timeline)).toBeLessThan(12)
    }
  })

  it("a jump to the next rest gets there, in a few jumps at most, after any kick", () => {
    for (const moment of moments) {
      for (const hand of [0, 1] as HandIndex[]) {
        const timeline = createFrisbeeTimeline({ seed: 21 })
        go(timeline, moment)
        timeline.kick(hand, 0, -1)
        go(timeline, 0.1)
        let jumps = 0
        while (timeline.secondsToRest() > 0 && jumps < 8) {
          timeline.advance(timeline.secondsToRest())
          jumps += 1
        }
        expect(timeline.secondsToRest()).toBe(0)
        timeline.write(FIELD)
        expect(timeline.disc.flying).toBe(false)
      }
    }
  })

  it("the art does not stop in the middle of an angry hand", () => {
    const timeline = inHold()
    const catcher: HandIndex = timeline.current().thrower === 0 ? 1 : 0
    timeline.kick(catcher, 0, -1)
    expect(timeline.secondsToRest()).toBeGreaterThan(0)
  })

  it("the scene passes a kick on to the game, and it knows where its hands are", () => {
    const scene = createFrisbeeScene({ seed: 7 })
    scene.setField(FIELD)
    const parts: PartSink = { box() {}, cylinder() {} }
    scene.update(0.3)
    scene.draw(parts, new Float32Array(64))
    scene.kick(0, 0, -1)
    expect(scene.secondsToRest()).toBeGreaterThan(0)
    const [from, to] = scene.handLine(0)
    expect(from[0]).toBeLessThan(0)
    expect(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])).toBeCloseTo(7.2, 1)
  })
})

describe("the fall", () => {
  const start = (x: number, y: number) => ({ x, y, z: 0, bank: 0.2, nose: 0, spin: 0, flying: false, balancing: false })

  it("bounces less each time, and it settles flat on the floor", () => {
    let seed = 0
    const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
    for (let run = 0; run < 30; run++) {
      const body = launchDisc(start(FIELD.span + DISC_RADIUS, 1), [0, 0, 0], DOWN, 0, FIELD, random)
      let time = 0
      while (!body.settled && time < 5) {
        stepDisc(body, STEP, FIELD)
        time += STEP
        expect(body.y).toBeGreaterThanOrEqual(FIELD.floor)
      }
      expect(body.settled).toBe(true)
      expect(time).toBeGreaterThan(0.5)
      expect(body.bank).toBeCloseTo(0, 5)
      expect(body.nose).toBeCloseTo(0, 5)
      expect(body.y).toBeLessThan(FIELD.floor + 0.3)
    }
  })

  it("falls as fast as the setting says", () => {
    const body = launchDisc(start(FIELD.span, 15), [0, 0, 0], { x: 0, y: 0 }, 0, FIELD, () => 0.5)
    const first = body.vy
    stepDisc(body, 0.1, FIELD)
    expect(body.vy).toBeCloseTo(first - DROP_GRAVITY * 0.1, 3)
  })

  it("never stops under the content or off the page, on any window and for any hit", () => {
    let seed = 1
    const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
    for (const { field } of LAYOUTS) {
      for (const s of [-1, 1]) {
        for (const x of [-1, -0.5, 0, 0.5, 1]) {
          for (const speed of [0, 20, 45]) {
            const body = launchDisc(start(s * (field.span + DISC_RADIUS), 2), [speed * x, 0, 0], { x, y: -0.4 }, 0, field, random)
            for (let t = 0; t < 5 && !body.settled; t += STEP) stepDisc(body, STEP, field)
            const [low, high] = floorBand(body.x, field)
            expect(body.x).toBeGreaterThanOrEqual(low - 1.2)
            expect(body.x).toBeLessThanOrEqual(high + 1.2)
            expect(Math.sign(body.x)).toBe(s)
          }
        }
      }
    }
  })

  it("lands on the bottom line of the hero, on any window", () => {
    for (const layout of LAYOUTS) {
      const { field, distance, unit, edge } = layout
      const viewProj = new Float32Array(16)
      const height = 845
      orbitCamera(viewProj, { azimuth: 0, elevation: CAMERA_ELEVATION, distance, focal: (2 * distance * unit) / height, aspect: (edge * 2 * unit) / height, shiftX: 0, shiftY: 0 })
      // The near edge of a flat disc is its lowest point on the screen.
      const [y, z] = [field.floor, DISC_RADIUS]
      const row = viewProj[1] * 0 + viewProj[5] * y + viewProj[9] * z + viewProj[13]
      const w = viewProj[3] * 0 + viewProj[7] * y + viewProj[11] * z + viewProj[15]
      const pixelsFromBottom = height - ((1 - row / w) / 2) * height
      expect(pixelsFromBottom).toBeGreaterThan(0.5)
      expect(pixelsFromBottom).toBeLessThan(8)
    }
  })
})

describe('the "why?!"', () => {
  const ready: [number, number, number] = [40, 2, 0]
  const pose = (): HandPose => ({ x: 0, y: 0, z: 0, bank: 0, nose: 0, wrist: 0, open: 0, point: 0, gap: 0, flat: 0, slide: 0, along: 0, stand: 0, glow: 0, roll: 0, push: 0, claw: 0, clench: 0 })

  it("turns the palm up and toward the visitor, on both hands", () => {
    for (const s of SIDES) {
      const out = pose()
      writeWhy(out, 0.3 + WHY_JAB_SECONDS * 1.5, s, [s * 40, 2, 0])
      const frame = handFrame(rigid(), out, gripFrame(s))
      // The y axis of the hand is the way that the back of the hand faces.
      expect(frame[9]).toBeLessThan(-0.3)
      expect(frame[5]).toBeLessThan(-0.1)
      expect(out.claw).toBe(1)
    }
  })

  it("jabs as many times as the setting says, and each jab is harder", () => {
    const out = pose()
    const peaks: number[] = []
    let before = -Infinity
    let rising = false
    for (let t = 0; t < WHY_SECONDS; t += 1 / 500) {
      writeWhy(out, t, 1, ready)
      // The tremble is small, so the jabs stand out from it.
      const smooth = out.y - Math.sin(t * 73) * 0.07 * writeWhy(out, t, 1, ready)
      if (smooth < before - 0.02 && rising) {
        peaks.push(before)
        rising = false
      }
      if (smooth > before + 0.001) rising = true
      before = smooth
    }
    expect(peaks.length).toBeGreaterThanOrEqual(WHY_JABS - 1)
    const big = peaks.filter((v) => v > ready[1] + 2.2)
    expect(big.length).toBe(WHY_JABS)
    for (let i = 1; i < big.length; i++) expect(big[i]).toBeGreaterThan(big[i - 1])
  })

  it("starts and ends with no share of the pose, so that it joins the game with no jump", () => {
    const out = pose()
    expect(writeWhy(out, 0, 1, ready)).toBe(0)
    expect(writeWhy(out, WHY_SECONDS, 1, ready)).toBeCloseTo(0, 6)
    expect(writeWhy(out, 0.3 + WHY_JAB_SECONDS, 1, ready)).toBe(1)
  })

  it("the fingers flare at the top of a jab and hook at the bottom", () => {
    const out = pose()
    const start = 0.3
    writeWhy(out, start + WHY_JAB_SECONDS * 0.02, 1, ready)
    const low = out.clench
    writeWhy(out, start + WHY_JAB_SECONDS * 0.7, 1, ready)
    const high = out.clench
    expect(high).toBeLessThan(low)
  })

  it("copies a pose whole", () => {
    const a = pose()
    a.x = 3
    a.clench = 0.4
    const b = pose()
    copyPose(b, a)
    expect(b).toEqual(a)
  })
})

describe("the parts", () => {
  /** A part past the limit of the renderer disappears with no error, so a scene must stay under it. */
  const count = (draw: (sink: PartSink) => void) => {
    let boxes = 0
    let cylinders = 0
    draw({
      box() {
        boxes += 1
      },
      cylinder() {
        cylinders += 1
      },
    })
    return { boxes, cylinders }
  }

  it("both scenes fit in the renderer, with the palm pads", () => {
    const hero = createFrisbeeScene({ seed: 7 })
    hero.setField(FIELD)
    const heroParts = count((sink) => hero.draw(sink, new Float32Array(64)))
    expect(heroParts.boxes).toBeLessThanOrEqual(MAX_BOXES)
    expect(heroParts.cylinders).toBeLessThanOrEqual(MAX_CYLINDERS)

    const solve = createSolveScene()
    const solveParts = count((sink) => solve.draw(sink, new Float32Array(64)))
    expect(solveParts.boxes).toBeLessThanOrEqual(MAX_BOXES)
    expect(solveParts.cylinders).toBeLessThanOrEqual(MAX_CYLINDERS)
  })
})
