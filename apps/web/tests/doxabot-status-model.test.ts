import { describe, expect, test } from "vitest"

import { getDoxabotStatusFacts } from "~/lib/dashboard/doxabot-status-model"

const NOW = new Date("2026-10-26T12:00:00Z").getTime()
const ENABLED = {
  available: true as const,
  unavailableReason: null,
  enabled: true,
  mergeTrigger: "batched" as const,
  batchQuietMinutes: 30 as const,
  repositoryVisibility: "private" as const,
  updatedAt: null,
}

describe("Doxabot status facts", () => {
  test("a set-up project shows its repository, last run, instructions and previews", () => {
    const facts = getDoxabotStatusFacts({
      project: { repositoryFullName: "acme/payments-api" },
      latestJob: { status: "succeeded", updatedAt: "2026-10-26T10:00:00Z" },
      instructions: { version: 3, createdAt: "2026-10-26T11:30:00Z" },
      doxabot: ENABLED,
      now: NOW,
    })

    expect(facts.map(({ label, value, tone }) => ({ label, value, tone }))).toEqual([
      { label: "Repository", value: "acme/payments-api", tone: undefined },
      { label: "Last generation", value: "Completed", tone: "success" },
      { label: "Instructions", value: "Version 3", tone: undefined },
      { label: "PR previews", value: "On", tone: undefined },
    ])
    expect(facts[1]?.detail).toBe("2 hours ago")
    expect(facts[2]?.detail).toBe("Edited 30 minutes ago")
  })

  test("a new project explains what is missing", () => {
    const facts = getDoxabotStatusFacts({
      project: { repositoryFullName: null },
      latestJob: null,
      instructions: null,
      doxabot: { ...ENABLED, available: false, enabled: false, unavailableReason: "repository_not_connected" },
      now: NOW,
    })

    expect(facts.map((fact) => fact.value)).toEqual(["Not connected", "None yet", "Not set", "Unavailable"])
  })
})
