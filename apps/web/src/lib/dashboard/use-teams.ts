import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { CreateTeamInviteInput, TeamDetail, TeamRole } from "@doxahq/contracts/teams"

import { planLimitDetails } from "~/lib/dashboard/billing-model"
import { teamErrorMessage, withPendingInvite, withoutPendingInvite } from "~/lib/dashboard/teams-model"
import { getErrorMessage } from "~/lib/errors"
import { approvalSettingsQueryKeys } from "~/lib/queries/approval-settings"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { teamDetailQueryOptions, teamInviteQueryOptions, teamQueryKeys, teamsQueryOptions } from "~/lib/queries/teams"
import {
  acceptTeamInvite,
  changeTeamMemberRole,
  createTeam,
  createTeamInvite,
  deleteTeam,
  moveProjectToTeam,
  removeTeamMember,
  renameTeam,
  revokeTeamInvite,
} from "~/lib/teams-api"

/** The user's teams and a create action. */
export function useTeams() {
  const queryClient = useQueryClient()
  const query = useQuery(teamsQueryOptions())
  const create = useMutation({
    mutationFn: createTeam,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamQueryKeys.list() }),
  })
  return {
    teams: query.data ?? [],
    isLoading: query.isPending,
    loadError: query.error ? getErrorMessage(query.error, "Your teams could not be loaded.") : null,
    create: (name: string) => create.mutateAsync(name),
    isCreating: create.isPending,
    // A plan refusal opens the upgrade dialog (`billing-denials.ts`), so the form shows no line for it.
    createError:
      create.error && !planLimitDetails(create.error)
        ? teamErrorMessage(create.error, "The team could not be created.")
        : null,
  }
}

/** One team page: its members and invites, and every change a manager can make. */
export function useTeam(teamId: string) {
  const queryClient = useQueryClient()
  const query = useQuery(teamDetailQueryOptions(teamId))

  const updateDetail = (update: (team: TeamDetail) => TeamDetail) =>
    queryClient.setQueryData<TeamDetail>(teamQueryKeys.detail(teamId), (team) => (team ? update(team) : team))

  // Members and projects change what other pages show, so they refresh too.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: teamQueryKeys.detail(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamQueryKeys.list() }),
    ])

  // A role change or a removal changes what members may do in the team's
  // projects: the teams list shows the role, the approval settings whether
  // the viewer may configure them.
  const refreshAccess = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: teamQueryKeys.list() }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.all }),
      queryClient.invalidateQueries({ queryKey: approvalSettingsQueryKeys.projects() }),
    ])

  const rename = useMutation({
    mutationFn: (name: string) => renameTeam(teamId, name),
    onSuccess: async (detail) => {
      queryClient.setQueryData(teamQueryKeys.detail(teamId), detail)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: teamQueryKeys.list() }),
        // Projects show their team's name.
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.all }),
      ])
    },
  })
  const remove = useMutation({
    mutationFn: () => deleteTeam(teamId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: teamQueryKeys.detail(teamId) })
      await queryClient.invalidateQueries({ queryKey: teamQueryKeys.list() })
    },
  })
  // The pending list shows each invite's link, so it changes at once.
  const invite = useMutation({
    mutationFn: (input: CreateTeamInviteInput) => createTeamInvite(teamId, input),
    onSuccess: async ({ invite: created }) => {
      updateDetail((team) => withPendingInvite(team, created))
      await refresh()
    },
  })
  const revoke = useMutation({
    mutationFn: (inviteId: string) => revokeTeamInvite(teamId, inviteId),
    onSuccess: async (_result, inviteId) => {
      updateDetail((team) => withoutPendingInvite(team, inviteId))
      await refresh()
    },
  })
  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: TeamRole }) => changeTeamMemberRole(teamId, input.userId, input.role),
    onSuccess: async (detail) => {
      queryClient.setQueryData(teamQueryKeys.detail(teamId), detail)
      await refreshAccess()
    },
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) => removeTeamMember(teamId, userId),
    onSuccess: async () => {
      await Promise.all([refresh(), refreshAccess()])
    },
  })

  const memberError = changeRole.error ?? removeMember.error
  return {
    team: query.data ?? null,
    isLoading: query.isPending,
    loadError: query.error ? getErrorMessage(query.error, "The team could not be loaded.") : null,
    rename: (name: string) => rename.mutateAsync(name),
    isRenaming: rename.isPending,
    renameError: rename.error ? teamErrorMessage(rename.error, "The team could not be renamed.") : null,
    deleteTeam: () => remove.mutateAsync(),
    isDeleting: remove.isPending,
    deleteError: remove.error ? teamErrorMessage(remove.error, "The team could not be deleted.") : null,
    resetDelete: () => remove.reset(),
    /** Resolves when the invite exists; a failure shows in `inviteError`. */
    createInvite: (input: CreateTeamInviteInput) => invite.mutateAsync(input).then(() => undefined),
    isCreatingInvite: invite.isPending,
    inviteError: invite.error ? teamErrorMessage(invite.error, "The invite link could not be created.") : null,
    revokeInvite: (inviteId: string) => revoke.mutate(inviteId),
    revokingInviteId: revoke.isPending ? revoke.variables : null,
    revokeError: revoke.error ? teamErrorMessage(revoke.error, "The invite could not be revoked.") : null,
    changeRole: (userId: string, role: TeamRole) => changeRole.mutate({ userId, role }),
    changingUserId: changeRole.isPending ? changeRole.variables.userId : null,
    removeMember: (userId: string) => removeMember.mutateAsync(userId),
    removingUserId: removeMember.isPending ? removeMember.variables : null,
    memberError: memberError ? teamErrorMessage(memberError, "The member could not be changed.") : null,
  }
}

/** The accept page of an invite link. */
export function useTeamInvite(token: string) {
  const queryClient = useQueryClient()
  const query = useQuery(teamInviteQueryOptions(token))
  const accept = useMutation({
    mutationFn: () => acceptTeamInvite(token),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: teamQueryKeys.all }),
        // The new team's projects join the project list.
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() }),
      ]),
  })
  return {
    preview: query.data ?? null,
    isLoading: query.isPending,
    loadError: query.error,
    accept: () => accept.mutateAsync(),
    isAccepting: accept.isPending,
    acceptError: accept.error,
  }
}

/** Project settings → Move to team. */
export function useMoveProjectToTeam(projectId: string) {
  const queryClient = useQueryClient()
  const move = useMutation({
    mutationFn: (teamId: string) => moveProjectToTeam(projectId, teamId),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() }),
        queryClient.invalidateQueries({ queryKey: teamQueryKeys.all }),
      ]),
  })
  return {
    move: (teamId: string) => move.mutateAsync(teamId),
    isMoving: move.isPending,
    error: move.error ? teamErrorMessage(move.error, "The project could not be moved.") : null,
    reset: () => move.reset(),
  }
}
