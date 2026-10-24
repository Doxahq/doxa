import { describe, expect, test } from "vitest"

import { getPendingMutationId } from "~/lib/dashboard/mutation-state"

describe("getPendingMutationId", () => {
  test("clears the last variables after a mutation finishes", () => {
    expect(getPendingMutationId(false, "domain-1")).toBeNull()
  })

  test("returns the active domain while a mutation is pending", () => {
    expect(getPendingMutationId(true, "domain-1")).toBe("domain-1")
  })

  test("returns null before a mutation has variables", () => {
    expect(getPendingMutationId(true, undefined)).toBeNull()
  })
})
