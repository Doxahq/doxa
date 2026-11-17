import { describe, expect, test } from "vitest"
import type { ProjectDto } from "@doxahq/contracts"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"
import type { TeamSummary } from "@doxahq/contracts/teams"

import {
  buildWorkspaces,
  canCreateProjectIn,
  canManageMembersOf,
  canReadBillingOf,
  landingProjectIdIn,
  PERSONAL_WORKSPACE_ID,
  workspaceInitials,
  workspaceSummary,
} from "~/lib/dashboard/workspace-model"
import {
  resolveCurrentWorkspaceId,
  switchDestination,
  workspacePageScope,
  type CurrentWorkspaceInput,
} from "~/lib/dashboard/workspace-routing"

const CODER_ONE = { id: "11111111-1111-4111-8111-111111111111", name: "Coder One" }
const ACME_LABS = { id: "22222222-2222-4222-8222-222222222222", name: "Acme Labs" }

function project(id: string, team: { id: string; name: string } | null): ProjectDto {
  return {
    id,
    name: id,
    slug: id,
    githubRepositoryId: null,
    repositoryFullName: null,
    publishedVersionId: null,
    docsUrl: null,
    team,
  }
}

function team(base: { id: string; name: string }, role: TeamSummary["role"], memberCount: number): TeamSummary {
  return { ...base, role, memberCount, projectCount: 0, createdAt: "2026-11-01T00:00:00.000Z" }
}

function account(id: string, owner: { id: string } | null, plan: string): BillingAccountSummary {
  return {
    id,
    ownerKind: owner ? "team" : "user",
    ownerId: owner?.id ?? "user-1",
    name: owner ? "team" : null,
    plan,
    canManage: true,
  }
}

const PROJECTS = [project("notes", null), project("payments", CODER_ONE), project("billing-api", CODER_ONE)]
const TEAMS = [team(CODER_ONE, "admin", 4), team(ACME_LABS, "viewer", 2)]
const ACCOUNTS = [account("acct-me", null, "free"), account("acct-co", CODER_ONE, "pro")]
const WORKSPACES = buildWorkspaces({ projects: PROJECTS, teams: TEAMS, billingAccounts: ACCOUNTS })

describe("workspaces", () => {
  test("Personal first, then the teams by name, with counts and the accounts the viewer can read", () => {
    expect(WORKSPACES.map((workspace) => workspace.name)).toEqual(["Personal", "Acme Labs", "Coder One"])
    const [personal, acme, coderOne] = WORKSPACES
    expect(workspaceSummary(personal)).toBe("Free · 1 project")
    expect(workspaceSummary(coderOne)).toBe("Pro · 4 members · 2 projects")
    // A viewer cannot read the team's billing: no plan in the summary.
    expect(workspaceSummary(acme)).toBe("2 members · 0 projects")
  })

  test("while the teams list loads, the teams of the projects stand in, with no role", () => {
    const loading = buildWorkspaces({ projects: PROJECTS, teams: undefined, billingAccounts: undefined })
    expect(loading.map((workspace) => workspace.name)).toEqual(["Personal", "Coder One"])
    expect(loading[1]).toMatchObject({ role: null, memberCount: null, projectCount: 2 })
    expect(canCreateProjectIn(loading[1])).toBe(false)
  })

  test("the role decides the actions: owners and admins create and manage, viewers do neither", () => {
    const [personal, acme, coderOne] = WORKSPACES
    expect([canCreateProjectIn(personal), canManageMembersOf(personal), canReadBillingOf(personal)]).toEqual([true, false, true])
    expect([canCreateProjectIn(coderOne), canManageMembersOf(coderOne), canReadBillingOf(coderOne)]).toEqual([true, true, true])
    expect([canCreateProjectIn(acme), canManageMembersOf(acme), canReadBillingOf(acme)]).toEqual([false, false, false])
  })

  test("a tile shows two initials", () => {
    expect(workspaceInitials("Coder One")).toBe("CO")
    expect(workspaceInitials("acme")).toBe("AC")
    expect(workspaceInitials("  ")).toBe("?")
  })

  test("a switch lands on the last project of the workspace, else its first, else nowhere", () => {
    expect(landingProjectIdIn(PROJECTS, CODER_ONE.id, "billing-api")).toBe("billing-api")
    expect(landingProjectIdIn(PROJECTS, CODER_ONE.id, "notes")).toBe("payments")
    expect(landingProjectIdIn(PROJECTS, ACME_LABS.id, null)).toBeNull()
  })
})

describe("the current workspace", () => {
  const base: CurrentWorkspaceInput = {
    scope: { kind: "chosen" },
    workspaces: WORKSPACES,
    projects: PROJECTS,
    billingAccounts: ACCOUNTS,
    storedId: CODER_ONE.id,
    lastProjectId: null,
    teamsKnown: true,
  }

  test("a project page takes its project's workspace, and waits while the project is unknown", () => {
    const scope = workspacePageScope("/dashboard/projects/notes/content")
    expect(scope).toEqual({ kind: "project", projectId: "notes" })
    expect(resolveCurrentWorkspaceId({ ...base, scope })).toBe(PERSONAL_WORKSPACE_ID)
    // Never the stored workspace first: that would flash another workspace.
    expect(resolveCurrentWorkspaceId({ ...base, scope, projects: undefined })).toBeNull()
  })

  test("a billing page takes its account's workspace", () => {
    const scope = workspacePageScope("/dashboard/billing/acct-co/credits")
    expect(scope).toEqual({ kind: "billing", accountId: "acct-co", page: "credits" })
    expect(resolveCurrentWorkspaceId({ ...base, scope })).toBe(CODER_ONE.id)
    expect(resolveCurrentWorkspaceId({ ...base, scope, billingAccounts: undefined })).toBeNull()
  })

  test("other pages show the stored choice, once the browser storage is read", () => {
    expect(workspacePageScope("/dashboard/projects/new")).toEqual({ kind: "chosen" })
    expect(resolveCurrentWorkspaceId(base)).toBe(CODER_ONE.id)
    expect(resolveCurrentWorkspaceId({ ...base, storedId: undefined })).toBeNull()
  })

  test("with nothing stored, the workspace of the last project; a team the viewer left falls back to Personal", () => {
    expect(resolveCurrentWorkspaceId({ ...base, storedId: null, lastProjectId: "payments" })).toBe(CODER_ONE.id)
    expect(resolveCurrentWorkspaceId({ ...base, storedId: null, lastProjectId: null })).toBe(PERSONAL_WORKSPACE_ID)
    expect(resolveCurrentWorkspaceId({ ...base, storedId: "gone-team" })).toBe(PERSONAL_WORKSPACE_ID)
    expect(resolveCurrentWorkspaceId({ ...base, storedId: "gone-team", teamsKnown: false })).toBeNull()
  })
})

describe("where a switch goes", () => {
  const [personal, acme, coderOne] = WORKSPACES

  test("from a project page: the new workspace's last project, else its New project page", () => {
    expect(
      switchDestination({ pathname: "/dashboard/projects/notes/project", target: coderOne, projects: PROJECTS, lastProjectIdInTarget: "billing-api" }),
    ).toEqual({ to: "/dashboard/projects/$projectId/project", params: { projectId: "billing-api" } })
    expect(
      switchDestination({ pathname: "/dashboard/projects/notes/project", target: acme, projects: PROJECTS, lastProjectIdInTarget: null }),
    ).toEqual({ to: "/dashboard/projects/new" })
  })

  test("from a billing page: the same page of the new workspace's account", () => {
    expect(
      switchDestination({ pathname: "/dashboard/billing/acct-me/credits", target: coderOne, projects: PROJECTS, lastProjectIdInTarget: null }),
    ).toEqual({ to: "/dashboard/billing/$accountId/credits", params: { accountId: "acct-co" } })
    expect(
      switchDestination({ pathname: "/dashboard/billing/acct-co", target: personal, projects: PROJECTS, lastProjectIdInTarget: null }),
    ).toEqual({ to: "/dashboard/billing/$accountId", params: { accountId: "acct-me" } })
  })

  test("pages of no workspace stay", () => {
    for (const pathname of ["/dashboard/projects/new", "/dashboard/settings", "/dashboard/teams", "/dashboard/teams/t1", "/dashboard/billing"]) {
      expect(switchDestination({ pathname, target: coderOne, projects: PROJECTS, lastProjectIdInTarget: null }), pathname).toBeNull()
    }
  })
})
