import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { GitHubInstallationDto, GitHubInstallationTransferTargetDto } from "@doxahq/contracts"

import { getErrorMessage } from "~/lib/errors"
import { transferGitHubInstallation } from "~/lib/platform-api"
import { dashboardQueryKeys, githubInstallationsQueryOptions } from "~/lib/queries/dashboard"

export interface GitHubInstallations {
  installations: GitHubInstallationDto[]
  transferTargets: GitHubInstallationTransferTargetDto[]
  isPending: boolean
  loadError: string | null
  transfer: (installationId: string, userId: string) => Promise<void>
  transferringId: string | null
  transferError: string | null
}

const NO_INSTALLATIONS: GitHubInstallationDto[] = []
const NO_TARGETS: GitHubInstallationTransferTargetDto[] = []

/**
 * The GitHub installations the user owns, and the move of one to a member of
 * the user's Doxa teams. A move refreshes the installations and repositories.
 */
export function useGitHubInstallations(): GitHubInstallations {
  const queryClient = useQueryClient()
  const query = useQuery(githubInstallationsQueryOptions())
  const mutation = useMutation({
    mutationFn: (input: { installationId: string; userId: string }) =>
      transferGitHubInstallation(input.installationId, input.userId),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() })
    },
  })

  return {
    installations: query.data?.installations ?? NO_INSTALLATIONS,
    transferTargets: query.data?.transferTargets ?? NO_TARGETS,
    isPending: query.isPending,
    loadError: query.error ? getErrorMessage(query.error, "Failed to load GitHub installations.") : null,
    transfer: async (installationId, userId) => {
      await mutation.mutateAsync({ installationId, userId })
    },
    transferringId: mutation.isPending ? (mutation.variables?.installationId ?? null) : null,
    transferError: mutation.error ? getErrorMessage(mutation.error, "Failed to move the installation.") : null,
  }
}
