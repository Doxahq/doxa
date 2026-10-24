import {
  acceptedTeamInviteSchema,
  createdTeamInviteSchema,
  teamDetailSchema,
  teamInvitePreviewSchema,
  teamListSchema,
  teamSummarySchema,
  type AcceptedTeamInvite,
  type CreateTeamInviteInput,
  type CreatedTeamInvite,
  type TeamDetail,
  type TeamInvitePreview,
  type TeamRole,
  type TeamSummary,
} from "@doxahq/contracts/teams"
import { z } from "zod"

import { apiFetch } from "~/lib/platform-api"

function teamPath(teamId: string): string {
  return `/teams/${encodeURIComponent(teamId)}`
}

function invitePath(token: string): string {
  return `/team-invites/${encodeURIComponent(token)}`
}

export async function listTeams(): Promise<TeamSummary[]> {
  return teamListSchema.parse(await apiFetch<unknown>("/teams")).teams
}

/** The creator becomes the first owner. */
export async function createTeam(name: string): Promise<TeamSummary> {
  const payload = await apiFetch<unknown>("/teams", { method: "POST", json: { name } })
  return z.object({ team: teamSummarySchema }).parse(payload).team
}

/** Fails with 404 for a team the user is not a member of. */
export async function getTeam(teamId: string): Promise<TeamDetail> {
  return teamDetailSchema.parse(await apiFetch<unknown>(teamPath(teamId)))
}

export async function renameTeam(teamId: string, name: string): Promise<TeamDetail> {
  return teamDetailSchema.parse(await apiFetch<unknown>(teamPath(teamId), { method: "PATCH", json: { name } }))
}

/** Fails with 409 `team_has_projects` while the team has projects. */
export async function deleteTeam(teamId: string): Promise<void> {
  await apiFetch<unknown>(teamPath(teamId), { method: "DELETE" })
}

/** The new invite, with its link; the team's pending invites list it too. */
export async function createTeamInvite(teamId: string, input: CreateTeamInviteInput): Promise<CreatedTeamInvite> {
  const payload = await apiFetch<unknown>(`${teamPath(teamId)}/invites`, { method: "POST", json: input })
  return createdTeamInviteSchema.parse(payload)
}

export async function revokeTeamInvite(teamId: string, inviteId: string): Promise<void> {
  await apiFetch<unknown>(`${teamPath(teamId)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" })
}

export async function changeTeamMemberRole(teamId: string, userId: string, role: TeamRole): Promise<TeamDetail> {
  const payload = await apiFetch<unknown>(`${teamPath(teamId)}/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    json: { role },
  })
  return teamDetailSchema.parse(payload)
}

/** Removing yourself leaves the team. */
export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  await apiFetch<unknown>(`${teamPath(teamId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" })
}

export async function getTeamInvite(token: string): Promise<TeamInvitePreview> {
  return teamInvitePreviewSchema.parse(await apiFetch<unknown>(invitePath(token)))
}

export async function acceptTeamInvite(token: string): Promise<AcceptedTeamInvite> {
  return acceptedTeamInviteSchema.parse(await apiFetch<unknown>(`${invitePath(token)}/accept`, { method: "POST" }))
}

/** Only the owner of a personal project, into a team they manage. */
export async function moveProjectToTeam(projectId: string, teamId: string): Promise<void> {
  await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/team`, { method: "PUT", json: { teamId } })
}
