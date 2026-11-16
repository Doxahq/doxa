import { describe, expect, test } from "vitest"
import type { DocsExportStatus } from "@doxahq/contracts/docs-export"

import { formatLimitValue } from "~/lib/dashboard/billing-model"
import { exportBlockedText, exportQuotaText, waitForExportClaim } from "~/lib/dashboard/docs-export"

const base: DocsExportStatus = {
  available: true,
  reason: null,
  version: { id: "v1", number: 3, publishedAt: "2026-11-15T09:00:00.000Z" },
  sizeBytes: 1000,
  maxBytes: 1024 * 1024 * 1024,
  quota: { available: true, plan: "free", windowHours: 24, resetsAt: "2026-11-17T00:00:00.000Z" },
}

describe("docs export card text", () => {
  test("names the plan quota", () => {
    expect(exportQuotaText(base)).toBe("Your plan allows one export every 24 hours.")
    expect(exportQuotaText({ ...base, quota: { ...base.quota, plan: "pro", windowHours: 1 } })).toBe("Your plan allows one export an hour.")
    expect(exportQuotaText({ ...base, quota: { available: true, plan: null, windowHours: null, resetsAt: null } })).toBeNull()
  })

  test("explains why an export cannot run", () => {
    expect(exportBlockedText(base)).toBeNull()
    expect(exportBlockedText({ ...base, available: false, reason: "no_published_version", version: null })).toMatch(/Publish the docs first/)
    expect(exportBlockedText({ ...base, available: false, reason: "too_large" })).toMatch(/larger than 1 GB/)
    const spent = { ...base, available: false, reason: "quota_spent" as const }
    expect(exportBlockedText(spent, new Date("2026-11-16T12:00:00.000Z"))).toMatch(/^You can export again on /)
  })

  test("shows the export window on the billing page", () => {
    expect(formatLimitValue("docs.export_window_hours", 24)).toBe("Once every 24 hours")
    expect(formatLimitValue("docs.export_window_hours", 1)).toBe("Once an hour")
    expect(formatLimitValue("docs.export_window_hours", 0)).toBe("Unlimited")
  })
})

describe("export redirect errors", async () => {
  const { exportRedirectErrorText } = await import("~/lib/dashboard/docs-export")
  test("maps known codes and hides unknown values", () => {
    expect(exportRedirectErrorText(null)).toBeNull()
    expect(exportRedirectErrorText("export_limit")).toMatch(/You used the export/)
    expect(exportRedirectErrorText("<script>")).toBe("The export did not start. Try again.")
    expect(exportRedirectErrorText("toString")).toBe("The export did not start. Try again.")
  })
})

describe("waitForExportClaim", () => {
  const sleep = async () => {}
  const spent: DocsExportStatus = { ...base, available: false, reason: "quota_spent" }

  test("reads again until the status shows the spent quota", async () => {
    const reads = [base, base, spent]
    let calls = 0
    const result = await waitForExportClaim(async () => reads[calls++]!, { sleep })
    expect(result).toBe(spent)
    expect(calls).toBe(3)
  })

  test("stops after the last attempt for a plan without a quota", async () => {
    let calls = 0
    const result = await waitForExportClaim(async () => (calls++, base), { attempts: 4, sleep })
    expect(result).toBe(base)
    expect(calls).toBe(4)
  })

  test("stops at once when a read fails", async () => {
    let calls = 0
    const result = await waitForExportClaim(async () => {
      calls += 1
      throw new Error("down")
    }, { sleep })
    expect(result).toBeNull()
    expect(calls).toBe(1)
  })
})
