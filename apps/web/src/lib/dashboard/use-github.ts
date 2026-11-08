import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { CreateProjectInput, GitHubRepositoryDto, ProjectDto } from "@doxahq/contracts"

import { mergeProjectIntoList } from "~/lib/dashboard/cache"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"
import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  githubRepositoriesQueryOptions,
} from "~/lib/queries/dashboard"
import { createProject, getApiUrl } from "~/lib/platform-api"

const SHOW_LOCAL_INSTALL_CALLBACK = Boolean(
  import.meta.env.DEV || import.meta.env.VITE_DEV_USER_ID,
)

export interface GitHubConnection {
  repositories: GitHubRepositoryDto[]
  repositoriesError: string | null
  isLoading: boolean
  isConnected: boolean
  githubInstallUrl: string
  localInstallCallbackUrl: string
  showLocalInstallCallback: boolean
  selectedRepositoryId: string
  selectedRepository: GitHubRepositoryDto | null
  selectedRepositoryProject: ProjectDto | null
  projectByRepositoryId: Map<string, ProjectDto>
  setSelectedRepositoryId: (repositoryId: string) => void
  createProject: (input: CreateProjectInput) => Promise<ProjectDto>
  isCreatingProject: boolean
  createError: string | null
}

export interface GitHubRepositories {
  repositories: GitHubRepositoryDto[]
  /** The message of a failed list. The list is then empty. */
  error: string | null
  isPending: boolean
}

/**
 * The repositories the GitHub App can read. Only the screens that show
 * repositories call it, so the other pages make no `/github/repos` request.
 */
export function useGitHubRepositories(): GitHubRepositories {
  const query = useQuery(githubRepositoriesQueryOptions())
  return {
    repositories: query.data?.repositories ?? NO_REPOSITORIES,
    error: query.data?.error ?? null,
    isPending: query.isPending,
  }
}

const NO_REPOSITORIES: GitHubRepositoryDto[] = []

/**
 * GitHub installation state + repo selection + project creation. Reuses the
 * shared projects and repositories queries and the existing `createProject`
 * mutation flow (optimistic merge into the projects cache).
 */
export function useGitHub(): GitHubConnection {
  const queryClient = useQueryClient()
  const projectsSummary = useProjectsSummary()
  const projects = projectsSummary.projects
  const repositoryList = useGitHubRepositories()
  const repositories = repositoryList.repositories
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string>("")

  const projectByRepositoryId = useMemo(() => {
    const entries = projects
      .filter((project): project is ProjectDto & { githubRepositoryId: string } => (
        Boolean(project.githubRepositoryId)
      ))
      .map((project) => [project.githubRepositoryId, project] as const)

    return new Map(entries)
  }, [projects])

  const selectedRepository =
    repositories.find((repo) => repo.id === selectedRepositoryId) ?? null
  const selectedRepositoryProject = selectedRepositoryId
    ? projectByRepositoryId.get(selectedRepositoryId) ?? null
    : null

  const createProjectMutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.setQueryData(
        dashboardQueryKeys.projects(),
        (current: ProjectDto[] | undefined) => mergeProjectIntoList(current, project),
      )
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() })
    },
  })

  return {
    repositories,
    repositoriesError: repositoryList.error,
    isLoading: projectsSummary.isPending || repositoryList.isPending,
    isConnected: repositories.length > 0,
    githubInstallUrl: getApiUrl("/github/install"),
    localInstallCallbackUrl: getApiUrl(
      "/github/install/callback?installation_id=local-dev&account=local",
    ),
    showLocalInstallCallback: SHOW_LOCAL_INSTALL_CALLBACK,
    selectedRepositoryId,
    selectedRepository,
    selectedRepositoryProject,
    projectByRepositoryId,
    setSelectedRepositoryId,
    createProject: (input) => createProjectMutation.mutateAsync(input),
    isCreatingProject: createProjectMutation.isPending,
    createError: createProjectMutation.error
      ? getErrorMessage(createProjectMutation.error, "Failed to create project.")
      : null,
  }
}
