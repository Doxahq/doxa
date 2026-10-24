import { describe, expect, test } from "vitest"

import {
  QUIET_TIME_OPTIONS,
  formatQuietTime,
  parseQuietMinutes,
  pendingMergesNextStep,
} from "~/lib/dashboard/doxabot-merge-model"

describe("Doxabot merge model", () => {
  test("offers the four quiet times in order", () => {
    expect(QUIET_TIME_OPTIONS.map((option) => option.label)).toEqual([
      "15 minutes",
      "30 minutes",
      "1 hour",
      "6 hours",
    ])
    expect(formatQuietTime(30)).toBe("30 minutes")
  })

  test("accepts only a known quiet time", () => {
    expect(parseQuietMinutes("60")).toBe(60)
    expect(parseQuietMinutes("45")).toBeNull()
  })

  test("states what happens to merged pull requests next", () => {
    expect(pendingMergesNextStep({ mergeTrigger: "manual", batchQuietMinutes: 30 })).toBe(
      "Generate to bring them into your docs.",
    )
    expect(pendingMergesNextStep({ mergeTrigger: "batched", batchQuietMinutes: 60 })).toBe(
      "Doxa updates your docs 1 hour after the last merge.",
    )
    expect(pendingMergesNextStep({ mergeTrigger: "every_merge", batchQuietMinutes: 30 })).toBe(
      "Doxa updates your docs after each merge.",
    )
  })
})
