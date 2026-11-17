import type { ProjectDto } from "@doxahq/contracts"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"
import { roleHasCapability, type Capability, type TeamRole, type TeamSummary } from "@doxahq/contracts/teams"

import { planName } from "~/lib/dashboard/billing-model"

/**
 * A workspace is where the dashboard works: the viewer's personal projects,
 * or one team. It scopes the project lists, the owner of a new project, and
 * the billing pages. Its ID is `"personal"` or the team ID.
 */
export type WorkspaceId = string

export const PERSONAL_WORKSPACE_ID: WorkspaceId = "personal"

export interface Workspace {
  readonly id: WorkspaceId
  /** Null for the personal workspace. */
  readonly teamId: string | null
  readonly name: string
  /**
   * The viewer's role. The personal workspace is the viewer's own (owner).
   * Null while the teams list loads: the dashboard then offers no team action.
   */
  readonly role: TeamRole | null
  /** Null for the personal workspace, and while the teams list loads. */
  readonly memberCount: number | null
  /** The projects of the workspace that the viewer sees. */
  readonly projectCount: number
  /** Null while billing is off, or when the role cannot read the team's billing. */
  readonly billingAccount: BillingAccountSummary | null
}

type ProjectWithTeam = Pick<ProjectDto, "team">

export function isPersonalWorkspace(workspace: Pick<Workspace, "teamId">): boolean {
  return workspace.teamId === null
}

export function workspaceIdOfProject(project: ProjectWithTeam): WorkspaceId {
  return project.team?.id ?? PERSONAL_WORKSPACE_ID
}

/** The projects of one workspace, in the order given. */
export function projectsInWorkspace<TProject extends ProjectWithTeam>(
  projects: readonly TProject[],
  workspaceId: WorkspaceId,
): TProject[] {
  return projects.filter((project) => workspaceIdOfProject(project) === workspaceId)
}

/** The billing account of a workspace in `GET /billing/accounts`, if the viewer can read it. */
export function workspaceBillingAccount(
  accounts: readonly BillingAccountSummary[],
  teamId: string | null,
): BillingAccountSummary | null {
  const account = accounts.find((candidate) =>
    teamId === null ? candidate.ownerKind === "user" : candidate.ownerKind === "team" && candidate.ownerId === teamId,
  )
  return account ?? null
}

/** The workspace that a billing account belongs to. */
export function workspaceIdOfBillingAccount(account: Pick<BillingAccountSummary, "ownerKind" | "ownerId">): WorkspaceId {
  return account.ownerKind === "user" ? PERSONAL_WORKSPACE_ID : account.ownerId
}

export interface WorkspaceSources {
  readonly projects: readonly ProjectDto[]
  /** Undefined while the teams list loads. */
  readonly teams: readonly TeamSummary[] | undefined
  /** Undefined while the account list loads, or when billing is off. */
  readonly billingAccounts: readonly BillingAccountSummary[] | undefined
}

/**
 * Every workspace of the viewer: personal first, then the teams by name.
 * While the teams list loads, the teams of the viewer's projects stand in
 * for it, so a project's workspace is known as soon as the project is.
 */
export function buildWorkspaces({ projects, teams, billingAccounts = [] }: WorkspaceSources): Workspace[] {
  const countOf = (workspaceId: WorkspaceId) => projectsInWorkspace(projects, workspaceId).length
  const personal: Workspace = {
    id: PERSONAL_WORKSPACE_ID,
    teamId: null,
    name: "Personal",
    role: "owner",
    memberCount: null,
    projectCount: countOf(PERSONAL_WORKSPACE_ID),
    billingAccount: workspaceBillingAccount(billingAccounts, null),
  }
  const teamSources: readonly TeamSource[] = teams ?? teamsOfProjects(projects)
  const teamWorkspaces = teamSources.map(
    (team): Workspace => ({
      id: team.id,
      teamId: team.id,
      name: team.name,
      role: team.role,
      memberCount: team.memberCount,
      projectCount: countOf(team.id),
      billingAccount: workspaceBillingAccount(billingAccounts, team.id),
    }),
  )
  teamWorkspaces.sort((a, b) => a.name.localeCompare(b.name))
  return [personal, ...teamWorkspaces]
}

/** A team as the workspace list needs it; role and members are null while the teams list loads. */
type TeamSource = Pick<TeamSummary, "id" | "name"> & { role: TeamRole | null; memberCount: number | null }

function teamsOfProjects(projects: readonly ProjectDto[]): TeamSource[] {
  const teams = new Map<string, TeamSource>()
  for (const { team } of projects) {
    if (team && !teams.has(team.id)) teams.set(team.id, { id: team.id, name: team.name, role: null, memberCount: null })
  }
  return [...teams.values()]
}

export function findWorkspace(workspaces: readonly Workspace[], workspaceId: WorkspaceId | null): Workspace | null {
  return workspaces.find((workspace) => workspace.id === workspaceId) ?? null
}

function workspaceCan(workspace: Pick<Workspace, "role">, capability: Capability): boolean {
  return workspace.role !== null && roleHasCapability(workspace.role, capability)
}

/** Owner or admin of a team; always in the personal workspace. */
export function canCreateProjectIn(workspace: Pick<Workspace, "role">): boolean {
  return workspaceCan(workspace, "project.create")
}

/** Invite, change roles, remove members. Never in the personal workspace. */
export function canManageMembersOf(workspace: Pick<Workspace, "role" | "teamId">): boolean {
  return workspace.teamId !== null && workspaceCan(workspace, "team.manage")
}

/** Plan, credits and invoices: the owner and admins of a team; always the personal account. */
export function canReadBillingOf(workspace: Pick<Workspace, "role">): boolean {
  return workspaceCan(workspace, "billing.read")
}

/** The plan as plain text, the members, the projects: "Pro · 4 members · 3 projects". */
export function workspaceSummary(workspace: Workspace): string {
  const parts: string[] = []
  if (workspace.billingAccount) parts.push(planName(workspace.billingAccount.plan))
  if (workspace.memberCount !== null) parts.push(countLabel(workspace.memberCount, "member"))
  parts.push(countLabel(workspace.projectCount, "project"))
  return parts.join(" · ")
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** The initials on a workspace tile: "CO" for Coder One. */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0] ?? "").slice(0, 2)
  return letters.toUpperCase() || "?"
}

/**
 * Where a workspace switch lands when the page belongs to one workspace:
 * the project opened last in the new workspace while it still exists, else
 * its first project, else null (the new project page).
 */
export function landingProjectIdIn(
  projects: readonly (ProjectWithTeam & { id: string })[],
  workspaceId: WorkspaceId,
  lastProjectId: string | null,
): string | null {
  const inWorkspace = projectsInWorkspace(projects, workspaceId)
  if (lastProjectId && inWorkspace.some(({ id }) => id === lastProjectId)) return lastProjectId
  return inWorkspace[0]?.id ?? null
}
