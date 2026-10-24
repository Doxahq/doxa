import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { ProjectDto } from "@doxahq/contracts"

import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  projectsListQueryOptions,
} from "~/lib/queries/dashboard"

export interface ProjectsSummary {
  projects: ProjectDto[]
  isPending: boolean
  isError: boolean
  error: string | null
  refresh: () => Promise<void>
}

export interface ProjectsSummaryOptions {
  /**
   * False for a view that mounts often, such as ⌘K: it then reads the cached
   * list and never refetches on open. Mutations still refresh the list.
   */
  refetchOnMount?: boolean
}

/**
 * The account's projects. Backed by the shared projects query, so every
 * consumer (shell, sidebar, overview, projects list, new-project flow) dedupes
 * onto one request.
 */
export function useProjectsSummary(options: ProjectsSummaryOptions = {}): ProjectsSummary {
  const queryClient = useQueryClient()
  const projectsQuery = useQuery({
    ...projectsListQueryOptions(),
    ...(options.refetchOnMount === false ? { refetchOnMount: false } : {}),
  })

  return {
    projects: projectsQuery.data ?? [],
    isPending: projectsQuery.isPending,
    isError: projectsQuery.isError,
    error: projectsQuery.error
      ? getErrorMessage(projectsQuery.error, "Failed to load dashboard.")
      : null,
    refresh: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects() })
    },
  }
}
