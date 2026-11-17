import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { ConnectProjectRepositoryInput, CreateExampleProjectInput, ProjectDto } from "@doxahq/contracts"

import { mergeProjectIntoList } from "~/lib/dashboard/cache"
import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  type ProjectDetail,
} from "~/lib/queries/dashboard"
import { teamQueryKeys } from "~/lib/queries/teams"
import { connectProjectRepository, createExampleProject } from "~/lib/platform-api"

function cacheProject(queryClient: ReturnType<typeof useQueryClient>, project: ProjectDto) {
  queryClient.setQueryData(
    dashboardQueryKeys.projects(),
    (projects: ProjectDto[] | undefined) => mergeProjectIntoList(projects, project),
  )
  queryClient.setQueryData(
    dashboardQueryKeys.project(project.id),
    (detail: ProjectDetail | undefined) => (detail ? { ...detail, project } : detail),
  )
}

/** A team project changes the team's project list and count. */
export function refreshTeamOfNewProject(queryClient: QueryClient, project: Pick<ProjectDto, "team">): Promise<void> {
  return project.team ? queryClient.invalidateQueries({ queryKey: teamQueryKeys.all }) : Promise.resolve()
}

/** Creates a project without a repository, with the starter docs or an empty site published. */
export function useCreateExampleProject() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: createExampleProject,
    onSuccess: async (project) => {
      cacheProject(queryClient, project)
      await refreshTeamOfNewProject(queryClient, project)
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() })
    },
  })

  return {
    createExampleProject: (input: CreateExampleProjectInput) => mutation.mutateAsync(input),
    isCreating: mutation.isPending,
    error: mutation.error ? getErrorMessage(mutation.error, "Failed to create project.") : null,
    reset: mutation.reset,
  }
}

/** Links a GitHub repository to a project that has none. */
export function useConnectProjectRepository(projectId: string) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: ConnectProjectRepositoryInput) => connectProjectRepository(projectId, input),
    onSuccess: (project) => cacheProject(queryClient, project),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) })
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() })
    },
  })

  return {
    /** `productionBranch` is the branch the person chose for production runs. */
    connectRepository: (githubRepositoryId: string, productionBranch: string) =>
      mutation.mutateAsync({ githubRepositoryId, productionBranch }),
    isConnecting: mutation.isPending,
    error: mutation.error ? getErrorMessage(mutation.error, "Failed to connect the repository.") : null,
    reset: mutation.reset,
  }
}
