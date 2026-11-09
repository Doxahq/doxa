import { describe, expect, test } from "vitest"
import type { ProjectActivityEvent } from "@doxahq/contracts/project-overview"

import { describeActivityEvent, filterActivity } from "~/lib/dashboard/project-activity-model"

const base = { id: "e1", occurredAt: "2026-11-09T10:00:00.000Z" }

const published: ProjectActivityEvent = {
  ...base,
  type: "published",
  actor: { kind: "doxabot", name: "Doxabot" },
  publicationKind: "generation",
  versionNumber: 42,
  changedPageCount: 6,
}

const agent: ProjectActivityEvent = {
  ...base,
  id: "e2",
  type: "agent_action",
  actor: { kind: "agent", name: "Claude Code" },
  actionKind: "domain.add",
}

describe("the activity feed", () => {
  test("describes a publication with its pages", () => {
    expect(describeActivityEvent(published)).toEqual({ what: "published version 42", detail: "6 pages updated" })
  })

  test("uses the singular for one page, and no detail without a count", () => {
    expect(describeActivityEvent({ ...published, changedPageCount: 1 }).detail).toBe("1 page updated")
    expect(describeActivityEvent({ ...published, changedPageCount: null }).detail).toBeNull()
  })

  test("a restore reads as a restore", () => {
    expect(describeActivityEvent({ ...published, publicationKind: "restore" }).what).toBe("restored version 42")
  })

  test("filters by who acted", () => {
    expect(filterActivity([published, agent], "all")).toHaveLength(2)
    expect(filterActivity([published, agent], "agent")).toEqual([agent])
    expect(filterActivity([published, agent], "person")).toEqual([])
  })
})
