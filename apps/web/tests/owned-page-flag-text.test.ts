import { describe, expect, test } from "vitest"

import { ownedPageFlagNotice, ownedPageFlagSummary } from "~/lib/dashboard/owned-page-flag-text"

const base = { href: "/auth", title: "Auth", changedPaths: [] }

describe("owned page flag text", () => {
  test("names the changed code", () => {
    const flag = { ...base, changedPaths: ["src/auth.ts"] }

    expect(ownedPageFlagSummary(flag)).toBe("1 source file changed")
    expect(ownedPageFlagNotice(flag)).toBe(
      "You own this page, so the generation kept it. Its code changed: src/auth.ts. Check that it is still right.",
    )
  })

  test("says that the page may not follow the new instructions", () => {
    const flag = { ...base, instructionsChanged: true as const }

    expect(ownedPageFlagSummary(flag)).toBe("instructions changed")
    expect(ownedPageFlagNotice(flag)).toContain("may not follow the current Doxabot instructions")
  })

  test("names both reasons together", () => {
    expect(ownedPageFlagSummary({ ...base, changedPaths: ["a.ts", "b.ts"], instructionsChanged: true })).toBe(
      "2 source files changed, instructions changed",
    )
  })

  test("says that the new plan left a removed page out", () => {
    const flag = { ...base, removed: true as const }

    expect(ownedPageFlagSummary(flag)).toBe("Not in the new plan")
    expect(ownedPageFlagNotice(flag)).toContain("left it out")
  })
})
