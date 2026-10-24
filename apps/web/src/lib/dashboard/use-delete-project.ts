import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ProjectDto } from "@doxahq/contracts"

import { removeProjectFromList } from "~/lib/dashboard/cache"
import { getErrorMessage } from "~/lib/errors"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { deleteProject } from "~/lib/platform-api"

/**
 * Deletes a project permanently.
 *
 * The project leaves the projects list at once, so the landing page picks another
 * project. Call `forgetProject` after the page has left the project: removing
 * its queries while they still have observers starts a refetch that fails.
 */
export function useDeleteProject(projectId: string) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: () => {
      queryClient.setQueryData(
        dashboardQueryKeys.projects(),
        (projects: ProjectDto[] | undefined) => removeProjectFromList(projects, projectId),
      )
    },
  })

  return {
    deleteProject: () => mutation.mutateAsync(),
    isDeleting: mutation.isPending,
    error: mutation.error ? getErrorMessage(mutation.error, "Failed to delete the project.") : null,
    reset: mutation.reset,
    forgetProject: () => {
      queryClient.removeQueries({ queryKey: dashboardQueryKeys.project(projectId) })
      void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() })
    },
  }
}
