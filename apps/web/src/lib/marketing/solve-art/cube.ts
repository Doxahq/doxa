/**
 * The logic of a real 3×3 cube, with the moves that a speedcuber uses. The cuber
 * faces the camera, so the cuber's right is world -x, and the cuber's front is
 * world -z. Each solve is a list of real moves, and the scramble is its inverse.
 */

export type Turn = 1 | -1
export type Face = "R" | "L" | "U" | "D" | "F"
export type Axis = 0 | 1 | 2

/**
 * A quarter turn of one face, clockwise when `dir` is 1, or a roll of the whole cube
 * around x. `beat` is the seconds that the cuber looks ahead before this move.
 */
export type Op = { kind: "turn"; face: Face; dir: Turn; beat?: number } | { kind: "roll"; dir: Turn; beat?: number }

export interface Cubie {
  /** The grid position when the cube is solved: each value is -1, 0 or 1. */
  readonly home: readonly [number, number, number]
  /** The current rotation: nine integers, row by row. */
  rotation: number[]
}

/** Where each face is, and the sign of its clockwise turn around the world axis. */
const LAYERS: Record<Face, { axis: Axis; coord: 1 | -1; sign: Turn }> = {
  R: { axis: 0, coord: -1, sign: 1 },
  L: { axis: 0, coord: 1, sign: -1 },
  U: { axis: 1, coord: 1, sign: -1 },
  D: { axis: 1, coord: -1, sign: 1 },
  F: { axis: 2, coord: -1, sign: 1 },
}

export function createCube(): Cubie[] {
  const cube: Cubie[] = []
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if (x !== 0 || y !== 0 || z !== 0) {
          cube.push({ home: [x, y, z], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] })
        }
      }
    }
  }
  return cube
}

/** The axis, the layer (0 is the whole cube) and the sign of the drawn rotation of an op. */
export function opLayer(op: Op): { axis: Axis; coord: number; sign: Turn } {
  if (op.kind === "roll") return { axis: 0, coord: 0, sign: op.dir }
  const { axis, coord, sign } = LAYERS[op.face]
  return { axis, coord, sign: (sign * op.dir) as Turn }
}

function quarterTurn(axis: Axis, s: Turn): number[] {
  if (axis === 0) return [1, 0, 0, 0, 0, -s, 0, s, 0]
  if (axis === 1) return [0, 0, s, 0, 1, 0, -s, 0, 0]
  return [0, -s, 0, s, 0, 0, 0, 0, 1]
}

function multiply3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[col + 3] + a[row * 3 + 2] * b[col + 6]
    }
  }
  return out
}

/** The position of the cubie on an axis, as it rests now: -1, 0 or 1. */
export function cubieCoord({ home, rotation }: Cubie, axis: Axis): number {
  return rotation[axis * 3] * home[0] + rotation[axis * 3 + 1] * home[1] + rotation[axis * 3 + 2] * home[2]
}

export function applyOp(cube: Cubie[], op: Op): void {
  const { axis, coord, sign } = opLayer(op)
  const quarter = quarterTurn(axis, sign)
  for (const cubie of cube) {
    if (coord === 0 || cubieCoord(cubie, axis) === coord) cubie.rotation = multiply3(quarter, cubie.rotation)
  }
}

/** The ops that undo `ops`. */
export function invertOps(ops: readonly Op[]): Op[] {
  return [...ops].reverse().map((op) => ({ ...op, dir: (op.dir === 1 ? -1 : 1) as Turn }))
}

/** A repeatable random generator, so a server, a test and a browser agree. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Reads move notation: "R U' F2 x". */
export function parseMoves(text: string): Op[] {
  const ops: Op[] = []
  for (const token of text.split(" ")) {
    const dir: Turn = token.endsWith("'") ? -1 : 1
    const op: Op = token[0] === "x" ? { kind: "roll", dir } : { kind: "turn", face: token[0] as Face, dir }
    ops.push(op)
    if (token.endsWith("2")) ops.push({ ...op })
  }
  return ops
}

/** The short sequences that put a corner and its edge in place. */
const PAIRS = [
  "R U R'",
  "R U' R'",
  "R U2 R'",
  "U R U' R'",
  "U' R U R'",
  "R' U R",
  "R' U' R",
  "L' U L",
  "L' U' L",
  "U' L' U L",
  "U L' U' L",
  "L U L'",
  "L U' L'",
  "F' U F",
  "F U' F'",
  "R U R' U' R U R'",
  "L' U' L U L' U' L",
  "D R D'",
  "D' L' D",
]

/** Real algorithms that orient the last layer. */
const ORIENT = ["F R U R' U' F'", "R U R' U R U2 R'", "R U2 R' U' R U' R'", "F U R U' R' F'", "L' U' L U' L' U2 L"]

/** Real algorithms that permute the last layer. */
const PERMUTE = [
  "R U R' U' R' F R2 U' R' U' R U R' F'",
  "R U R' F' R U R' U' R' F R2 U' R' U'",
  "R U' R U R U R U' R' U' R2",
  "R2 U R U R' U' R' U' R' U R'",
]

const CROSS_FACES: Face[] = ["R", "L", "F", "D", "U"]
const LOOK_AT_PAIRS = 0.14
const LOOK_AT_PAIR = 0.07
const LOOK_AT_LAST_LAYER = 0.16

/**
 * One solve, in the order that a speedcuber works: the cross, four pairs, then the
 * last layer. A scramble is the inverse of a solve, so each one ends on a solved cube.
 */
export function solveOps(seed: number): Op[] {
  const random = seededRandom(seed)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]
  const ops: Op[] = []

  const add = (text: string, beat = 0) => {
    parseMoves(text).forEach((op, i) => {
      const previous = ops.at(-1)
      // A move that undoes the move before it is a wasted move, so both go.
      if (previous && previous.kind === "turn" && op.kind === "turn" && previous.face === op.face && previous.dir !== op.dir) {
        ops.pop()
        return
      }
      ops.push(i === 0 && beat > 0 ? { ...op, beat } : op)
    })
  }

  let face = pick(CROSS_FACES)
  for (let i = 0; i < 7; i++) {
    add(`${face}${random() < 0.5 ? "'" : ""}`)
    const previous = face
    while (face === previous) face = pick(CROSS_FACES)
  }
  add(random() < 0.5 ? "x" : "x'", LOOK_AT_PAIRS)
  for (let i = 0; i < 4; i++) add(pick(PAIRS), LOOK_AT_PAIR)
  add(pick(ORIENT), LOOK_AT_LAST_LAYER)
  add(pick(PERMUTE), LOOK_AT_LAST_LAYER)
  add(random() < 0.5 ? "U" : "U'")
  return ops
}

/** True when each face of the cube shows one color. */
export function isSolved(cube: readonly Cubie[]): boolean {
  const colors = new Map<string, number>()
  for (const { home, rotation } of cube) {
    for (let axis = 0; axis < 3; axis++) {
      if (home[axis] === 0) continue
      const color = axis * 2 + (home[axis] > 0 ? 1 : 0)
      const face = [0, 1, 2].map((row) => rotation[row * 3 + axis] * home[axis]).join()
      if (colors.has(face) && colors.get(face) !== color) return false
      colors.set(face, color)
    }
  }
  return true
}
