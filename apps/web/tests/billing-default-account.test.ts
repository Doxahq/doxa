import { describe, expect, test } from "vitest"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"

import { defaultBillingAccountId } from "~/lib/dashboard/billing-model"

function account(id: string, ownerKind: "user" | "team", plan: string): Pick<BillingAccountSummary, "id" | "ownerKind" | "plan"> {
  return { id, ownerKind, plan }
}

describe("the default billing account", () => {
  test("is the first account on a paid plan, in the switcher's order", () => {
    expect(
      defaultBillingAccountId([account("me", "user", "free"), account("team-a", "team", "pro"), account("team-b", "team", "enterprise")]),
    ).toBe("team-a")
  })

  test("is the personal account when it is on a paid plan, even with paid teams after it", () => {
    expect(defaultBillingAccountId([account("me", "user", "pro"), account("team-a", "team", "pro")])).toBe("me")
  })

  test("falls back to the personal account when no account is paid", () => {
    expect(defaultBillingAccountId([account("team-a", "team", "free"), account("me", "user", "free")])).toBe("me")
    // Self-hosted and unknown plans are not paid plans.
    expect(defaultBillingAccountId([account("me", "user", "free"), account("team-a", "team", "self_hosted")])).toBe("me")
  })

  test("is null without accounts", () => {
    expect(defaultBillingAccountId([])).toBeNull()
  })
})
