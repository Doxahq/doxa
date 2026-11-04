import { useMutation, useQuery } from "@tanstack/react-query"
import type { AgentConsentDecision, ApproveAgentConsentInput } from "@doxahq/contracts/agent-access"

import { approveAgentConsent, denyAgentConsent } from "~/lib/agent-access-api"
import { isNavigableRedirect } from "~/lib/oauth/consent-model"
import { agentConsentQueryOptions } from "~/lib/queries/agent-access"

export type ConsentDecisionRequest =
  | { kind: "approve"; input: ApproveAgentConsentInput }
  | { kind: "deny" }

export class UnsafeConsentRedirectError extends Error {
  constructor() {
    super("The agent returned a redirect the browser cannot open.")
    this.name = "UnsafeConsentRedirectError"
  }
}

/**
 * Loads a pending consent request and sends the person's decision. After a
 * decision the browser leaves for the agent's redirect, so the mutation stays
 * pending-looking (`isSuccess`) until the page unloads.
 */
export function useAgentConsent(consentId: string) {
  const consent = useQuery({
    ...agentConsentQueryOptions(consentId),
    enabled: consentId.length > 0,
  })

  const decision = useMutation({
    mutationFn: async (request: ConsentDecisionRequest): Promise<AgentConsentDecision> => {
      const result = request.kind === "approve"
        ? await approveAgentConsent(consentId, request.input)
        : await denyAgentConsent(consentId)
      const redirectHost = consent.data?.client.redirectHost ?? ""
      if (!isNavigableRedirect(result.redirectTo, redirectHost)) throw new UnsafeConsentRedirectError()
      return result
    },
    onSuccess: ({ redirectTo }) => {
      window.location.assign(redirectTo)
    },
  })

  return { consent, decision }
}
