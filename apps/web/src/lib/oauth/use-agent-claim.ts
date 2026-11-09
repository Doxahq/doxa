import { useEffect } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { ApproveAgentClaimInput } from "@doxahq/contracts/agent-access"

import { approveAgentClaim, denyAgentClaim } from "~/lib/agent-access-api"
import { claimReturnPath } from "~/lib/oauth/claim-model"
import { agentClaimDetailsQueryOptions, agentClaimOpenQueryOptions } from "~/lib/queries/agent-access"

export type ClaimDecisionRequest =
  | { kind: "approve"; input: Omit<ApproveAgentClaimInput, "attemptToken"> }
  | { kind: "deny" }

/**
 * Marks the claim as opened, sends a signed-out person to sign in and back,
 * then loads the claim and sends the decision.
 */
export function useAgentClaim(attemptToken: string, signedIn: boolean) {
  const navigate = useNavigate()
  const hasToken = attemptToken.length > 0

  const opened = useQuery({ ...agentClaimOpenQueryOptions(attemptToken), enabled: hasToken })

  const details = useQuery({
    ...agentClaimDetailsQueryOptions(attemptToken),
    enabled: hasToken && signedIn && opened.isSuccess,
  })

  useEffect(() => {
    if (signedIn || !opened.isSuccess) return
    void navigate({ to: "/login", search: { redirect: claimReturnPath(attemptToken) }, replace: true })
  }, [attemptToken, navigate, opened.isSuccess, signedIn])

  const decision = useMutation({
    mutationFn: (request: ClaimDecisionRequest): Promise<void> =>
      request.kind === "approve"
        ? approveAgentClaim({ ...request.input, attemptToken })
        : denyAgentClaim({ attemptToken }),
  })

  return { opened, details, decision }
}
