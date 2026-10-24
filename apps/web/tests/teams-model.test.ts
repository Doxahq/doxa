import type { TeamSummary } from "@doxahq/contracts/teams"
import { describe, expect, test } from "vitest"

import { ApiRequestError } from "~/lib/api-errors"
import { decisionErrorMessage, requesterLabel } from "~/lib/dashboard/approval-request-model"
import {
  assignableRoles,
  canChangeMemberRole,
  canMoveProjectToTeam,
  canRemoveMember,
  groupProjectsByTeam,
  hasTeamProjects,
  inviteFailureOf,
  inviteFailureView,
  leaveBlockReason,
  manageableTeams,
  teamErrorMessage,
} from "~/lib/dashboard/teams-model"

const ACME = { id: "11111111-1111-4111-8111-111111111111", name: "Acme" }
const BETA = { id: "22222222-2222-4222-8222-222222222222", name: "Beta" }

describe("groupProjectsByTeam", () => {
  test("puts personal projects first, then each team by name, keeping order inside a group", () => {
    const groups = groupProjectsByTeam([
      { id: "p1", team: BETA },
      { id: "p2", team: null },
      { id: "p3", team: ACME },
      { id: "p4", team: BETA },
      { id: "p5", team: null },
    ])
    expect(groups.map((group) => [group.team?.name ?? "Personal", group.projects.map(({ id }) => id)])).toEqual([
      ["Personal", ["p2", "p5"]],
      ["Acme", ["p3"]],
      ["Beta", ["p1", "p4"]],
    ])
  })

  test("leaves out an empty personal group", () => {
    expect(groupProjectsByTeam([{ id: "p1", team: ACME }]).map((group) => group.team?.name)).toEqual(["Acme"])
    expect(groupProjectsByTeam([])).toEqual([])
  })

  test("knows when a list has team projects", () => {
    expect(hasTeamProjects([{ team: null }])).toBe(false)
    expect(hasTeamProjects([{ team: null }, { team: ACME }])).toBe(true)
  })
})

describe("role gating", () => {
  test("only an owner may give the owner role", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "editor", "viewer"])
    expect(assignableRoles("admin")).toEqual(["admin", "editor", "viewer"])
  })

  test("a manager changes members, but only an owner touches an owner", () => {
    expect(canChangeMemberRole("owner", { role: "owner" })).toBe(true)
    expect(canChangeMemberRole("admin", { role: "owner" })).toBe(false)
    expect(canChangeMemberRole("admin", { role: "editor" })).toBe(true)
    expect(canChangeMemberRole("editor", { role: "viewer" })).toBe(false)
    expect(canChangeMemberRole("viewer", { role: "viewer" })).toBe(false)
  })

  test("nobody removes themselves from their row; they leave instead", () => {
    expect(canRemoveMember("owner", "u1", { userId: "u1", role: "owner" })).toBe(false)
    expect(canRemoveMember("owner", "u1", { userId: "u2", role: "owner" })).toBe(true)
    expect(canRemoveMember("admin", "u1", { userId: "u2", role: "owner" })).toBe(false)
    expect(canRemoveMember("editor", "u1", { userId: "u2", role: "viewer" })).toBe(false)
  })

  test("moving a project needs the owner of a personal project", () => {
    expect(canMoveProjectToTeam({ team: null }, "owner")).toBe(true)
    expect(canMoveProjectToTeam({ team: ACME }, "owner")).toBe(false)
    expect(canMoveProjectToTeam({ team: null }, "admin")).toBe(false)
    expect(canMoveProjectToTeam({ team: null }, null)).toBe(false)
  })

  test("move targets are the teams the user manages", () => {
    const teams: TeamSummary[] = (["owner", "admin", "editor", "viewer"] as const).map((role, index) => ({
      id: `${index}`,
      name: role,
      role,
      memberCount: 1,
      projectCount: 0,
      createdAt: "2026-10-05T00:00:00.000Z",
    }))
    expect(manageableTeams(teams).map(({ role }) => role)).toEqual(["owner", "admin"])
  })
})

describe("invite failures", () => {
  test.each([
    [404, "invite_not_found", "Invite not found"],
    [410, "invite_used", "Invite already used"],
    [410, "invite_expired", "Invite expired"],
    [410, "invite_revoked", "Invite revoked"],
    [409, "already_member", "Already a member"],
  ])("maps %s %s to a clean message", (status, code, title) => {
    const error = new ApiRequestError("server text", status, code)
    expect(inviteFailureOf(error)).toBe(code)
    expect(inviteFailureView(error).title).toBe(title)
  })

  test("any other failure keeps its message", () => {
    const view = inviteFailureView(new Error("Network down"))
    expect(view.title).toBe("Invite unavailable")
    expect(view.description).toBe("Network down")
    expect(inviteFailureOf(new ApiRequestError("x", 500, "internal"))).toBeNull()
  })
})

describe("team errors", () => {
  test("explains the team rules by code", () => {
    expect(teamErrorMessage(new ApiRequestError("x", 409, "last_owner"), "fallback")).toContain("at least one owner")
    expect(teamErrorMessage(new ApiRequestError("x", 409, "team_has_projects"), "fallback")).toContain("projects")
    expect(teamErrorMessage(new ApiRequestError("Server says no", 400, null), "fallback")).toBe("Server says no")
    expect(teamErrorMessage("not an error", "fallback")).toBe("fallback")
  })
})

describe("approval requests in a team", () => {
  test("names the member and the agent", () => {
    expect(requesterLabel({ name: "Jane Doe", clientName: "Claude Code" })).toBe("Jane Doe via Claude Code")
    expect(requesterLabel({ name: null, clientName: "Claude Code" })).toBe("Claude Code")
  })

  test("explains the second-person rule", () => {
    const error = new ApiRequestError("server text", 403, "other_decider_required")
    expect(decisionErrorMessage(error, "fallback")).toContain("another member")
    expect(decisionErrorMessage(new Error("Conflict"), "fallback")).toBe("Conflict")
  })
})

describe("leaveBlockReason", () => {
  const owner = (userId: string) => ({ userId, role: "owner" as const })
  const editor = (userId: string) => ({ userId, role: "editor" as const })

  test("blocks the only owner while other members remain", () => {
    expect(leaveBlockReason([owner("me"), editor("u2"), editor("u3")], "me")).toBe("only_owner")
  })

  test("blocks the only member, who deletes the team instead", () => {
    expect(leaveBlockReason([owner("me")], "me")).toBe("only_member")
  })

  test("lets an owner leave when another owner remains", () => {
    expect(leaveBlockReason([owner("me"), owner("u2")], "me")).toBeNull()
  })

  test("lets a member who is not an owner leave", () => {
    expect(leaveBlockReason([owner("u1"), editor("me")], "me")).toBeNull()
  })

  test("does not block before the user is known", () => {
    expect(leaveBlockReason([owner("u1")], null)).toBeNull()
  })
})
