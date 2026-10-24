import { describe, expect, it } from "vitest"

import { stepKeySequence, type KeySequence } from "~/lib/dashboard/key-sequence"

const SEQUENCES: readonly KeySequence[] = [
  ["g", "o"],
  ["g", "g"],
  ["c", "p"],
]

describe("stepKeySequence", () => {
  it("waits after the first key of a sequence", () => {
    expect(stepKeySequence(null, "g", SEQUENCES)).toEqual({ pending: "g", match: null })
  })

  it("matches the second key and starts over", () => {
    expect(stepKeySequence("g", "o", SEQUENCES)).toEqual({ pending: null, match: ["g", "o"] })
  })

  it("matches a sequence that repeats its key", () => {
    expect(stepKeySequence("g", "g", SEQUENCES).match).toEqual(["g", "g"])
  })

  it("ignores the case of the key", () => {
    expect(stepKeySequence("g", "O", SEQUENCES).match).toEqual(["g", "o"])
  })

  it("drops a key that starts no sequence", () => {
    expect(stepKeySequence(null, "x", SEQUENCES)).toEqual({ pending: null, match: null })
  })

  it("lets a wrong second key start a new sequence", () => {
    expect(stepKeySequence("g", "c", SEQUENCES)).toEqual({ pending: "c", match: null })
  })
})
