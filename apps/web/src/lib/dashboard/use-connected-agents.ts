import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { revokeAgentGrant } from "~/lib/agent-access-api"
import { getErrorMessage } from "~/lib/errors"
import { agentAccessQueryKeys, agentGrantsQueryOptions } from "~/lib/queries/agent-access"

/** The agents connected to the account, and a revoke action that refreshes the list. */
export function useConnectedAgents() {
  const queryClient = useQueryClient()
  const grantsQuery = useQuery(agentGrantsQueryOptions())

  const revokeMutation = useMutation({
    mutationFn: revokeAgentGrant,
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: agentAccessQueryKeys.grants() })
    },
  })

  return {
    grants: grantsQuery.data?.grants ?? [],
    isLoading: grantsQuery.isPending,
    loadError: grantsQuery.error
      ? getErrorMessage(grantsQuery.error, "Could not load connected agents.")
      : null,
    revoke: (grantId: string) => revokeMutation.mutateAsync(grantId),
    revokingGrantId: revokeMutation.isPending ? revokeMutation.variables : null,
    revokeError: revokeMutation.error
      ? getErrorMessage(revokeMutation.error, "Could not revoke this agent.")
      : null,
  }
}
