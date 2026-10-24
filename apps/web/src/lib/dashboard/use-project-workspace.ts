import { useQuery } from "@tanstack/react-query"
import type { GenerationJobDto, ProjectDto } from "@doxahq/contracts"

import { getErrorMessage } from "~/lib/errors"
import { projectDetailQueryOptions } from "~/lib/queries/dashboard"

export interface ProjectWorkspaceState {
  project: ProjectDto | null
  latestJob: GenerationJobDto | null
  isLoading: boolean
  error: string | null
}

export function useProjectWorkspace(projectId: string): ProjectWorkspaceState {
  const projectQuery = useQuery(projectDetailQueryOptions(projectId))
  const project = projectQuery.data?.project ?? null

  return {
    project,
    latestJob: projectQuery.data?.latestJob ?? null,
    isLoading: projectQuery.isPending,
    error: projectQuery.error
      ? getErrorMessage(projectQuery.error, "Failed to load project.")
      : null,
  }
}
