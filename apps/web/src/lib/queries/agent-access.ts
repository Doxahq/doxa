import { queryOptions } from "@tanstack/react-query"

import { getAgentClaim, getAgentConsent, listAgentGrants, openAgentClaim } from "~/lib/agent-access-api"
import { ApiRequestError } from "~/lib/api-errors"

const ROOT_KEY = ["agent-access"] as const

export const agentAccessQueryKeys = {
  all: ROOT_KEY,
  grants: () => [...ROOT_KEY, "grants"] as const,
  consent: (consentId: string) => [...ROOT_KEY, "consents", consentId] as const,
  claimOpen: (attemptToken: string) => [...ROOT_KEY, "claims", attemptToken, "open"] as const,
  claim: (attemptToken: string) => [...ROOT_KEY, "claims", attemptToken] as const,
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

/** Runs once per page load. A query returns a value, so the result is true. */
export function agentClaimOpenQueryOptions(attemptToken: string) {
  return queryOptions({
    queryKey: agentAccessQueryKeys.claimOpen(attemptToken),
    queryFn: async () => {
      await openAgentClaim({ attemptToken })
      return true
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => !isExpiredConsentError(error) && failureCount < 2,
  })
}

/** A claim is single use, so the page reads it once and never refetches it. */
export function agentClaimDetailsQueryOptions(attemptToken: string) {
  return queryOptions({
    queryKey: agentAccessQueryKeys.claim(attemptToken),
    queryFn: () => getAgentClaim({ attemptToken }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => !isExpiredConsentError(error) && failureCount < 2,
  })
}

/** True when the API no longer knows the consent request (unknown or expired). */
export function isExpiredConsentError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404
}
