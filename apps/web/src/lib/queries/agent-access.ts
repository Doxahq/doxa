import { queryOptions } from "@tanstack/react-query"

import { getAgentConsent, listAgentGrants } from "~/lib/agent-access-api"
import { ApiRequestError } from "~/lib/api-errors"

const ROOT_KEY = ["agent-access"] as const

export const agentAccessQueryKeys = {
  all: ROOT_KEY,
  grants: () => [...ROOT_KEY, "grants"] as const,
  consent: (consentId: string) => [...ROOT_KEY, "consents", consentId] as const,
}

export function agentGrantsQueryOptions() {
  return queryOptions({
    queryKey: agentAccessQueryKeys.grants(),
    queryFn: listAgentGrants,
    staleTime: 30_000,
  })
}

/**
 * A pending consent lives for 10 minutes and is single use, so the page reads
 * it once and never refetches it in the background.
 */
export function agentConsentQueryOptions(consentId: string) {
  return queryOptions({
    queryKey: agentAccessQueryKeys.consent(consentId),
    queryFn: () => getAgentConsent(consentId),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => !isExpiredConsentError(error) && failureCount < 2,
  })
}

/** True when the API no longer knows the consent request (unknown or expired). */
export function isExpiredConsentError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404
}
