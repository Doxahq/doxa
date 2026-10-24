import { queryOptions } from "@tanstack/react-query"

import { getTeam, getTeamInvite, listTeams } from "~/lib/teams-api"

const ROOT_KEY = ["teams"] as const

export const teamQueryKeys = {
  all: ROOT_KEY,
  list: () => [...ROOT_KEY, "list"] as const,
  detail: (teamId: string) => [...ROOT_KEY, "detail", teamId] as const,
  invite: (token: string) => [...ROOT_KEY, "invite", token] as const,
}

export function teamsQueryOptions() {
  return queryOptions({
    queryKey: teamQueryKeys.list(),
    queryFn: listTeams,
    staleTime: 30_000,
  })
}

export function teamDetailQueryOptions(teamId: string) {
  return queryOptions({
    queryKey: teamQueryKeys.detail(teamId),
    queryFn: () => getTeam(teamId),
    staleTime: 10_000,
  })
}

/** An invite link can stop working at any time, so it is never retried or cached long. */
export function teamInviteQueryOptions(token: string) {
  return queryOptions({
    queryKey: teamQueryKeys.invite(token),
    queryFn: () => getTeamInvite(token),
    staleTime: 0,
    retry: false,
  })
}
