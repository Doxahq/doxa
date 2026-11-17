import {
  MAX_OWNED_TEAMS,
  TEAM_INVITE_EMAILS_PER_HOUR,
  TEAM_INVITE_EMAILS_PER_SENDER_PER_HOUR,
  TEAM_ROLES,
  roleHasCapability,
  teamInviteFailureSchema,
  type TeamDetail,
  type TeamInvite,
  type TeamInviteFailure,
  type TeamMember,
  type TeamRole,
  type TeamSummary,
} from "@doxahq/contracts/teams"

import { ApiRequestError } from "~/lib/api-errors"

/** `#invites` on a team page: the invite form, where the logo menu's "Invite members" lands. */
export const TEAM_INVITES_ANCHOR = "invites"

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
}

export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  owner: "Everything, including deleting projects and the team",
  admin: "Everything except deleting projects and the team",
  editor: "Writes, publishes and decides agent requests",
  viewer: "Reads the docs and the project",
}

/** Only an owner gives the owner role. */
export function assignableRoles(viewerRole: TeamRole): TeamRole[] {
  return TEAM_ROLES.filter((role) => role !== "owner" || viewerRole === "owner")
}

/** A manager changes a member's role; only an owner touches an owner. */
export function canChangeMemberRole(viewerRole: TeamRole, member: Pick<TeamMember, "role">): boolean {
  if (!roleHasCapability(viewerRole, "team.manage")) return false
  return member.role !== "owner" || viewerRole === "owner"
}

/** Anyone may leave; removing someone else follows the role rule. */
export function canRemoveMember(
  viewerRole: TeamRole,
  viewerUserId: string | null,
  member: Pick<TeamMember, "role" | "userId">,
): boolean {
  if (member.userId === viewerUserId) return false
  return canChangeMemberRole(viewerRole, member)
}

/** Why the signed-in user cannot leave the team, mirroring the API's `last_owner` refusal. */
export type LeaveBlockReason = "only_owner" | "only_member"

/**
 * Null when the user may leave. The last owner may not: with other members
 * they first make one an owner, and alone they delete the team instead.
 */
export function leaveBlockReason(
  members: readonly Pick<TeamMember, "role" | "userId">[],
  userId: string | null,
): LeaveBlockReason | null {
  const owners = members.filter((member) => member.role === "owner")
  if (owners.length !== 1 || owners[0]?.userId !== userId) return null
  return members.length === 1 ? "only_member" : "only_owner"
}

export const LEAVE_BLOCK_NOTES: Record<LeaveBlockReason, string> = {
  only_owner: "You are the only owner of this team. Make another member an owner before you leave.",
  only_member: "You are the only member of this team. Delete the team instead of leaving it.",
}

/** The teams a user can move a project into. */
export function manageableTeams(teams: readonly TeamSummary[]): TeamSummary[] {
  return teams.filter((team) => roleHasCapability(team.role, "team.manage"))
}

/** Only the owner of a personal project moves it (spec §5). */
export function canMoveProjectToTeam(project: { team: unknown | null }, role: TeamRole | null): boolean {
  return project.team === null && role === "owner"
}

export interface TeamGroup<TProject> {
  /** Null for the personal projects. */
  readonly team: { readonly id: string; readonly name: string } | null
  readonly projects: TProject[]
}

/**
 * Personal projects first, then one group per team by name. The order of
 * the projects inside a group stays as given. Empty groups are left out.
 */
export function groupProjectsByTeam<TProject extends { team: { id: string; name: string } | null }>(
  projects: readonly TProject[],
): TeamGroup<TProject>[] {
  const personal: TProject[] = []
  const teams = new Map<string, TeamGroup<TProject>>()
  for (const project of projects) {
    if (project.team === null) {
      personal.push(project)
      continue
    }
    const group = teams.get(project.team.id) ?? { team: project.team, projects: [] }
    group.projects.push(project)
    teams.set(project.team.id, group)
  }
  const teamGroups = [...teams.values()].sort((a, b) => (a.team?.name ?? "").localeCompare(b.team?.name ?? ""))
  return personal.length > 0 ? [{ team: null, projects: personal }, ...teamGroups] : teamGroups
}

/** True when grouping adds anything: at least one team project. */
export function hasTeamProjects(projects: readonly { team: unknown | null }[]): boolean {
  return projects.some((project) => project.team !== null)
}

const TEAM_ERROR_MESSAGES: Record<string, string> = {
  last_owner: "A team needs at least one owner. Make another member an owner first.",
  owner_role_required: "Only an owner can give or change the owner role.",
  team_has_projects: "Move or delete the team's projects before you delete the team.",
  project_in_team: "This project is already in a team.",
  invite_email_limit: `This team sent ${TEAM_INVITE_EMAILS_PER_HOUR} invites by email in the last hour. Try again later, or create an invite link and share it yourself.`,
  invite_sender_limit: `You sent ${TEAM_INVITE_EMAILS_PER_SENDER_PER_HOUR} invites by email in the last hour. Try again later, or create an invite link and share it yourself.`,
  invite_recipient_limit: "You sent several invite emails to this address today. Create an invite link and send it yourself.",
  member_owns_projects: "This member still owns projects in this team. Delete those projects before the member leaves the team.",
  team_limit: `You own ${MAX_OWNED_TEAMS} teams. Delete a team or hand over its ownership before you create another.`,
  forbidden: "Your role does not allow this action.",
}

/** A clear message for a refused team change. */
export function teamErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.code !== null) {
    const known = TEAM_ERROR_MESSAGES[error.code]
    if (known) return known
  }
  return error instanceof Error ? error.message : fallback
}

const INVITE_FAILURE_VIEW: Record<TeamInviteFailure, { title: string; description: string }> = {
  invite_not_found: {
    title: "Invite not found",
    description: "This invite link is not valid. Check the link, or ask the team admin for a new one.",
  },
  invite_used: {
    title: "Invite already used",
    description: "Each invite link works once. Ask the team admin for a new one.",
  },
  invite_expired: {
    title: "Invite expired",
    description: "Invite links work for 7 days. Ask the team admin for a new one.",
  },
  invite_revoked: {
    title: "Invite revoked",
    description: "A team admin revoked this link. Ask them for a new one.",
  },
  already_member: {
    title: "Already a member",
    description: "You are already a member of this team.",
  },
  invite_email_mismatch: {
    title: "Invite for another address",
    description:
      "This invite was sent to another email address. Sign in with that address, or ask the team admin for an invite link.",
  },
}

/** The invite failure code of an error, or null for any other failure. */
export function inviteFailureOf(error: unknown): TeamInviteFailure | null {
  if (!(error instanceof ApiRequestError)) return null
  const code = teamInviteFailureSchema.safeParse(error.code)
  return code.success ? code.data : null
}

/** What the accept page shows when the link does not work. */
export function inviteFailureView(error: unknown): { title: string; description: string } {
  const code = inviteFailureOf(error)
  if (code) return INVITE_FAILURE_VIEW[code]
  return {
    title: "Invite unavailable",
    description: error instanceof Error ? error.message : "The invite could not be loaded. Try again.",
  }
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })

export function formatTeamDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso))
}

/** The team with a new pending invite listed last, as the API orders them. */
export function withPendingInvite(team: TeamDetail, invite: TeamInvite): TeamDetail {
  const others = team.invites.filter((entry) => entry.id !== invite.id)
  return { ...team, invites: [...others, invite] }
}

/** The team without a revoked invite, so its link is gone at once. */
export function withoutPendingInvite(team: TeamDetail, inviteId: string): TeamDetail {
  return { ...team, invites: team.invites.filter((invite) => invite.id !== inviteId) }
}
