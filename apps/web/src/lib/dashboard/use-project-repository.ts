import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { CreateExampleProjectInput, ProjectDto } from "@doxahq/contracts"

import { mergeProjectIntoList } from "~/lib/dashboard/cache"
import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  type ProjectDetail,
} from "~/lib/queries/dashboard"
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

/** Creates a project without a repository, with the starter docs or an empty site published. */
export function useCreateExampleProject() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: createExampleProject,
    onSuccess: (project) => cacheProject(queryClient, project),
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
    mutationFn: (githubRepositoryId: string) => connectProjectRepository(projectId, githubRepositoryId),
    onSuccess: (project) => cacheProject(queryClient, project),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) })
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() })
    },
  })

  return {
    connectRepository: (githubRepositoryId: string) => mutation.mutateAsync(githubRepositoryId),
    isConnecting: mutation.isPending,
    error: mutation.error ? getErrorMessage(mutation.error, "Failed to connect the repository.") : null,
    reset: mutation.reset,
  }
}
