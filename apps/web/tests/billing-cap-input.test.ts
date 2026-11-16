import { describe, expect, test } from "vitest"

import { parseCap } from "~/lib/dashboard/billing-model"

describe("the cap per run field", () => {
  test("a whole number in the range is the cap; commas are allowed", () => {
    expect(parseCap("20", 20, 10_000)).toEqual({ credits: 20 })
    expect(parseCap(" 3,000 ", 20, 10_000)).toEqual({ credits: 3_000 })
    expect(parseCap("10000", 20, 10_000)).toEqual({ credits: 10_000 })
  })

  test("each mistake gets its own message", () => {
    expect(parseCap("", 20, 10_000)).toEqual({ error: "Enter a cap in credits, from 20 to 10,000." })
    expect(parseCap("abc", 20, 10_000)).toEqual({ error: "Enter a cap in credits, from 20 to 10,000." })
    expect(parseCap("12.5", 20, 10_000)).toEqual({ error: "Use whole credits, with no decimals." })
    expect(parseCap("10", 20, 10_000)).toEqual({ error: "The lowest cap is 20 credits." })
    expect(parseCap("10001", 20, 10_000)).toEqual({ error: "The highest cap is 10,000 credits." })
  })
})
