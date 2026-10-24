import { queryOptions } from "@tanstack/react-query"

import { getProjectApprovalSettings, getUserApprovalSettings } from "~/lib/approval-settings-api"

const ROOT_KEY = ["approval-settings"] as const

/**
 * One root for both scopes: a user setting changes the effective mode shown
 * on every project page, so a user save invalidates `projects()`.
 */
export const approvalSettingsQueryKeys = {
  all: ROOT_KEY,
  projects: () => [...ROOT_KEY, "project"] as const,
  project: (projectId: string) => [...approvalSettingsQueryKeys.projects(), projectId] as const,
  user: () => [...ROOT_KEY, "user"] as const,
}

/** Settings change only from this page, so they stay fresh for a while. */
export function projectApprovalSettingsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: approvalSettingsQueryKeys.project(projectId),
    queryFn: () => getProjectApprovalSettings(projectId),
    staleTime: 60_000,
  })
}

export function userApprovalSettingsQueryOptions() {
  return queryOptions({
    queryKey: approvalSettingsQueryKeys.user(),
    queryFn: getUserApprovalSettings,
    staleTime: 60_000,
  })
}
