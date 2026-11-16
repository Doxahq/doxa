import { describe, expect, it } from "vitest"

import { applyOp, createCube, cubieCoord, invertOps, isSolved, parseMoves, solveOps, type Cubie } from "~/lib/marketing/solve-art/cube"
import { canvasPixelRatio } from "~/lib/marketing/solve-art"
import { invert, multiply, orbitCamera, rigid, rotateX, rotateY, transformPoint, translate, type Rigid } from "~/lib/marketing/solve-art/math"
import { boxMesh, cylinderMesh, type MeshData } from "~/lib/marketing/solve-art/renderer"
import { drawHand, type HandRig } from "~/lib/marketing/solve-art/rig"
import { handFrame, handRig, handTargets, restFrame, rootFrame, SIDES } from "~/lib/marketing/solve-art/scene"
import { createTimeline, FINGERS, type HandIndex, type Pose, type Stage } from "~/lib/marketing/solve-art/timeline"

const QUARTER = Math.PI / 2
const FRAME = 1 / 60

/** The points of each part of a hand in the world: its center and both ends of its long side. */
function handParts(rig: HandRig, frame: Rigid, targets: Float32Array, tips: Float32Array): number[][] {
  const points: number[][] = []
  const add = (m: Rigid, half: number) => {
    points.push([m[3], m[7], m[11]])
    for (const end of [-half, half]) points.push(transformPoint(m, 0, 0, end))
  }
  drawHand({ box: (m, _hx, _hy, hz) => add(m, hz), cylinder: (m) => add(m, 0) }, rig, frame, targets, 1, tips, 0)
  return points
}

/** The number of colors on each of the six faces, as the cube rests now. */
function colorsPerFace(cube: Cubie[]): number[] {
  const faces = new Map<string, Set<number>>()
  for (const cubie of cube) {
    const { home, rotation } = cubie
    for (let axis = 0; axis < 3; axis++) {
      if (home[axis] === 0) continue
      const face = [0, 1, 2].map((row) => rotation[row * 3 + axis] * home[axis]).join()
      if (!faces.has(face)) faces.set(face, new Set())
      faces.get(face)?.add(axis * 2 + (home[axis] > 0 ? 1 : 0))
    }
  }
  return [...faces.values()].map((colors) => colors.size)
}

describe("cube", () => {
  it("has 26 cubies, with 9 in each face", () => {
    const cube = createCube()
    expect(cube).toHaveLength(26)
    for (const axis of [0, 1, 2] as const) {
      for (const coord of [-1, 1]) expect(cube.filter((c) => cubieCoord(c, axis) === coord)).toHaveLength(9)
    }
  })

  it("stays solved after a roll and leaves solved after a turn of any face", () => {
    for (const face of ["R", "L", "U", "D", "F"]) {
      const cube = createCube()
      applyOp(cube, parseMoves("x")[0])
      expect(isSolved(cube)).toBe(true)
      applyOp(cube, parseMoves(face)[0])
      expect(isSolved(cube), face).toBe(false)
    }
  })

  it("is back to solved after four turns of one face, and after a move and its inverse", () => {
    for (const face of ["R", "L", "U", "D", "F"]) {
      const cube = createCube()
      for (const op of parseMoves(`${face}2 ${face}2`)) applyOp(cube, op)
      expect(isSolved(cube), face).toBe(true)
      for (const op of parseMoves(`${face} ${face}'`)) applyOp(cube, op)
      expect(isSolved(cube), face).toBe(true)
    }
  })

  it("turns each face clockwise as seen from outside", () => {
    // After R, the piece at the right of the front, on the cuber's side, goes to the top.
    const cube = createCube()
    const piece = cube.find((c) => c.home[0] === -1 && c.home[1] === 0 && c.home[2] === -1)
    if (!piece) throw new Error("no piece")
    applyOp(cube, parseMoves("R")[0])
    expect(cubieCoord(piece, 1)).toBe(1)
    expect(cubieCoord(piece, 2)).toBe(0)
  })

  it("reads move notation", () => {
    expect(parseMoves("R U' F2 x'")).toEqual([
      { kind: "turn", face: "R", dir: 1 },
      { kind: "turn", face: "U", dir: -1 },
      { kind: "turn", face: "F", dir: 1 },
      { kind: "turn", face: "F", dir: 1 },
      { kind: "roll", dir: -1 },
    ])
  })

  it("makes a solve that really solves its scramble, and the scramble is well mixed", () => {
    for (let seed = 0; seed < 40; seed++) {
      const cube = createCube()
      const solve = solveOps(seed)
      for (const op of invertOps(solve)) applyOp(cube, op)
      expect(isSolved(cube), `seed ${seed}`).toBe(false)
      expect(Math.min(...colorsPerFace(cube)), `seed ${seed}`).toBeGreaterThanOrEqual(3)
      for (const op of solve) applyOp(cube, op)
      expect(isSolved(cube), `seed ${seed}`).toBe(true)
    }
  })

  it("has no move that undoes the move before it", () => {
    for (let seed = 0; seed < 40; seed++) {
      solveOps(seed).forEach((op, i, ops) => {
        const previous = ops[i - 1]
        if (previous?.kind === "turn" && op.kind === "turn" && previous.face === op.face) expect(previous.dir).toBe(op.dir)
      })
    }
  })

  it("makes the same solve from the same seed", () => {
    expect(solveOps(11)).toEqual(solveOps(11))
    expect(solveOps(11)).not.toEqual(solveOps(12))
  })
})

describe("timeline", () => {
  /** Runs every frame of several whole loops. */
  function eachFrame(check: (pose: Pose, stage: Stage, cube: Cubie[]) => void, seconds = 60): void {
    const cube = createCube()
    const timeline = createTimeline(cube, { seed: 11 })
    for (let i = 0; i < 60 * seconds; i++) {
      timeline.advance(FRAME)
      check(timeline.pose, timeline.stage(), cube)
    }
  }

  it("starts on a scrambled cube, with both hands on it", () => {
    const cube = createCube()
    const { pose, stage } = createTimeline(cube, { seed: 11 })
    expect(isSolved(cube)).toBe(false)
    expect(stage()).toBe("solving")
    expect(pose.hands.map((hand) => hand.open)).toEqual([0, 0])
    expect(pose.hands.map((hand) => hand.away)).toEqual([0, 0])
  })

  it("runs the loop in order: solving, solved, shaken, solving", () => {
    const stages: Stage[] = []
    eachFrame((_pose, stage, cube) => {
      if (stages.at(-1) !== stage) stages.push(stage)
      if (stage === "solved") expect(isSolved(cube)).toBe(true)
    })
    expect(stages.slice(0, 7)).toEqual(["solving", "solved", "changed", "solving", "solved", "changed", "solving"])
  })

  it("solves quickly", () => {
    let seconds = 0
    let solves = 0
    eachFrame((_pose, stage) => {
      if (stage === "solving") {
        seconds += FRAME
      } else if (seconds > 0) {
        expect(seconds).toBeLessThan(8.5)
        expect(seconds).toBeGreaterThan(4)
        seconds = 0
        solves += 1
      }
    })
    expect(solves).toBeGreaterThan(3)
  })

  it("scrambles by the shake alone: no layer turns, and the cube is scrambled when it ends", () => {
    let was: Stage = "solving"
    let shaken = 0
    eachFrame((pose, stage, cube) => {
      if (stage === "changed") {
        expect(pose.turn).toBeNull()
        if (was === "solved") {
          expect(isSolved(cube)).toBe(true)
          shaken += 1
        }
      } else if (was === "changed") {
        expect(isSolved(cube)).toBe(false)
        expect(Math.min(...colorsPerFace(cube))).toBeGreaterThanOrEqual(3)
      }
      was = stage
    })
    expect(shaken).toBeGreaterThan(3)
  })

  it("shakes the cube in one hand, with the other hand clear of it", () => {
    let hardest = 0
    eachFrame((pose) => {
      if (pose.shake <= 0.5) return
      hardest = Math.max(hardest, pose.shake)
      expect(pose.hands[1].open).toBeCloseTo(0)
      expect(pose.hands[1].away).toBeCloseTo(0)
      expect(pose.hands[0].open).toBeGreaterThan(0.7)
      expect(pose.hands[0].away).toBeGreaterThan(0.7)
    })
    expect(hardest).toBeCloseTo(1)
  })

  it("never lets go of the cube: a hand always grips it", () => {
    eachFrame((pose) => {
      expect(Math.min(pose.hands[0].open, pose.hands[1].open)).toBeLessThan(0.6)
    })
  })

  it("keeps the hands near the cube through a solve, as a real grip does", () => {
    eachFrame((pose, stage) => {
      if (stage !== "solving") return
      for (const hand of pose.hands) {
        expect(Math.abs(hand.rock)).toBeLessThan(0.4)
        // Only the first frames of a solve still bring the free hand back.
        if (pose.turn) expect(hand.away).toBeLessThan(0.45)
      }
    })
  })

  it("moves with no jump from frame to frame, in the whole loop", () => {
    let previous: Pose | null = null
    eachFrame((pose) => {
      if (previous) {
        const gap = (a: number, b: number) => Math.abs(a - b)
        for (const h of [0, 1] as const) {
          const hand = pose.hands[h]
          const before = previous.hands[h]
          expect(gap(hand.rock, before.rock)).toBeLessThan(0.14)
          expect(gap(hand.carry, before.carry)).toBeLessThan(0.3)
          expect(gap(hand.open, before.open)).toBeLessThan(0.34)
          expect(gap(hand.away, before.away)).toBeLessThan(0.2)
          for (let f = 0; f < FINGERS; f++) {
            expect(gap(hand.lift[f], before.lift[f])).toBeLessThan(0.5)
            expect(gap(hand.touch[f], before.touch[f])).toBeLessThan(0.75)
          }
        }
        expect(gap(pose.yaw, previous.yaw)).toBeLessThan(0.07)
        expect(gap(pose.pitch, previous.pitch)).toBeLessThan(0.07)
        expect(gap(pose.roll, previous.roll)).toBeLessThan(0.07)
      }
      previous = structuredClone(pose)
    })
  })

  it("stays correct after one very long frame", () => {
    const timeline = createTimeline(createCube(), { seed: 11 })
    timeline.advance(10_000)
    expect(["solving", "solved", "changed"]).toContain(timeline.stage())
    expect(Number.isFinite(timeline.pose.yaw)).toBe(true)
  })

  it("keeps the fingers out of the cube in the whole loop, past a light touch on a corner", () => {
    const rigs = [handRig(-1), handRig(1)]
    const rests = [restFrame(-1), restFrame(1)]
    const frame = rigid()
    const root = rigid()
    const targets = new Float32Array(FINGERS * 3)
    const tips = new Float32Array(FINGERS * 3)
    let deepest = -Infinity
    let where = ""

    eachFrame((pose, stage) => {
      if (pose.shake > 0) return
      for (const h of [0, 1] as HandIndex[]) {
        rootFrame(root, pose, false)
        handFrame(frame, root, pose.hands[h], SIDES[h], rests[h])
        handTargets(targets, rigs[h], root, frame, pose, h)
        const toCube = invert(root)
        for (const [wx, wy, wz] of handParts(rigs[h], frame, targets, tips)) {
          let [x, y, z] = transformPoint(toCube, wx, wy, wz)
          const { turn } = pose
          const coord = turn ? [x, y, z][turn.axis] : 0
          if (turn && (turn.coord === 0 || coord * turn.coord > 0.5)) {
            const c = Math.cos(-turn.angle)
            const s = Math.sin(-turn.angle)
            if (turn.axis === 0) [y, z] = [y * c - z * s, y * s + z * c]
            else if (turn.axis === 1) [x, z] = [x * c + z * s, z * c - x * s]
            else [x, y] = [x * c - y * s, x * s + y * c]
          }
          const depth = 1.5 - Math.max(Math.abs(x), Math.abs(y), Math.abs(z))
          if (depth > deepest) {
            deepest = depth
            where = `${stage} hand ${h} depth ${depth.toFixed(3)} at ${[x, y, z].map((n) => n.toFixed(2))} ${JSON.stringify({ turn, rock: pose.hands[h].rock, carry: pose.hands[h].carry, open: pose.hands[h].open, touch: pose.hands[h].touch, sweep: pose.hands[h].sweep })}`
          }
        }
      }
    })
    // A fingertip rides on a corner that turns under it, so for a few frames a joint can
    // touch a corner. This limit is a fifth of one cubie. Past it, a finger shows inside the cube.
    expect(deepest, where).toBeLessThan(0.2)
  })
})

describe("hands", () => {
  const rest = (h: HandIndex) => {
    const pose = createTimeline(createCube(), { seed: 11 }).pose
    const root = rootFrame(rigid(), pose, false)
    const frame = handFrame(rigid(), root, pose.hands[h], SIDES[h], restFrame(SIDES[h]))
    const targets = new Float32Array(FINGERS * 3)
    const tips = new Float32Array(FINGERS * 3)
    const rig = handRig(SIDES[h])
    handTargets(targets, rig, root, frame, pose, h)
    handParts(rig, frame, targets, tips)
    const toCube = invert(root)
    return [0, 1, 2, 3, 4].map((f) => transformPoint(toCube, tips[f * 3], tips[f * 3 + 1], tips[f * 3 + 2]))
  }

  it.each([0, 1] as HandIndex[])("rests each fingertip of hand %i on the cube", (h) => {
    for (const tip of rest(h)) {
      const out = Math.max(Math.abs(tip[0]), Math.abs(tip[1]), Math.abs(tip[2]))
      expect(out).toBeGreaterThan(1.5)
      expect(out).toBeLessThan(1.8)
    }
  })

  it("holds the cube on both sides: four fingers on the near face and the thumb on the side of the far layer", () => {
    for (const h of [0, 1] as HandIndex[]) {
      const tips = rest(h)
      for (const tip of tips) expect(Math.sign(tip[0])).toBe(SIDES[h])
      for (const tip of tips.slice(0, 4)) expect(tip[2]).toBeGreaterThan(1.5)
      expect(tips[4][2]).toBeLessThan(-0.5)
      expect(Math.abs(tips[4][0])).toBeGreaterThan(1.5)
      // From the index to the little finger, the tips go down the face.
      expect(tips[0][1]).toBeGreaterThan(tips[1][1])
      expect(tips[1][1]).toBeGreaterThan(tips[2][1])
      expect(tips[2][1]).toBeGreaterThan(tips[3][1])
    }
  })

  it("mirrors one hand to the other at rest", () => {
    const left = rest(0)
    const right = rest(1)
    left.forEach((tip, f) => {
      expect(tip[0]).toBeCloseTo(-right[f][0], 1)
      expect(tip[1]).toBeCloseTo(right[f][1], 1)
      expect(tip[2]).toBeCloseTo(right[f][2], 1)
    })
  })
})

describe("math", () => {
  it("undoes a transform with its inverse", () => {
    const m = rigid()
    translate(m, m, 1, 2, 3)
    rotateY(m, m, 0.7)
    rotateX(m, m, -0.3)
    const back = multiply(rigid(), invert(m), m)
    const [x, y, z] = transformPoint(back, 4, 5, 6)
    expect(x).toBeCloseTo(4)
    expect(y).toBeCloseTo(5)
    expect(z).toBeCloseTo(6)
  })

  it("flexes +z toward -y and yaws +z toward +x", () => {
    const flexed = transformPoint(rotateX(rigid(), rigid(), QUARTER), 0, 0, 1)
    expect(flexed[1]).toBeCloseTo(-1)
    const yawed = transformPoint(rotateY(rigid(), rigid(), QUARTER), 0, 0, 1)
    expect(yawed[0]).toBeCloseTo(1)
  })

  it("puts the origin at the shifted point of the screen", () => {
    const m = new Float32Array(16)
    orbitCamera(m, { azimuth: 0.7, elevation: 0.4, distance: 22, focal: 3, aspect: 1.6, shiftX: 0.3, shiftY: -0.2 })
    expect(m[12] / m[15]).toBeCloseTo(0.3)
    expect(m[13] / m[15]).toBeCloseTo(-0.2)
  })
})

describe("canvasPixelRatio", () => {
  it("keeps the normal cap in a normal window", () => {
    expect(canvasPixelRatio(2, 1440, 884)).toBe(1.25)
    expect(canvasPixelRatio(1, 1440, 884)).toBe(1)
  })

  it("holds a very wide window to the pixel budget", () => {
    const ratio = canvasPixelRatio(2, 2527, 884)
    expect(ratio).toBeLessThan(1.25)
    expect(2527 * ratio * 884 * ratio).toBeLessThanOrEqual(3_000_001)
  })
})

describe("meshes", () => {
  /** In a closed mesh with one winding, each edge appears once in each direction between positions. */
  function openEdges(mesh: MeshData): number {
    const key = (v: number) => {
      const at = (n: number) => mesh.corner[v * 3 + n] + mesh.offset[v * 3 + n] * 0.2
      return [at(0), at(1), at(2)].map((x) => x.toFixed(4)).join()
    }
    const edges = new Map<string, number>()
    for (let i = 0; i < mesh.index.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = key(mesh.index[i + k])
        const b = key(mesh.index[i + ((k + 1) % 3)])
        if (a === b) continue
        edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1)
      }
    }
    let open = 0
    for (const [edge, count] of edges) {
      const [a, b] = edge.split(">")
      if ((edges.get(`${b}>${a}`) ?? 0) !== count) open += 1
    }
    return open
  }

  it("builds a closed box of 24 vertices and 44 triangles", () => {
    const mesh = boxMesh()
    expect(mesh.corner.length / 3).toBe(24)
    expect(mesh.index.length / 3).toBe(44)
    expect(openEdges(mesh)).toBe(0)
  })

  it("builds a closed cylinder", () => {
    expect(openEdges(cylinderMesh())).toBe(0)
  })
})
