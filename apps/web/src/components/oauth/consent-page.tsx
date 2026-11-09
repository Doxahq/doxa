import { AuthCard } from "~/components/auth/auth-card"
import { ConsentForm, type ConsentDecisionState } from "~/components/oauth/consent-form"
import { ConsentCardHeader, ConsentMessage } from "~/components/oauth/consent-message"
import { Button } from "~/components/ui/button"
import { isExpiredConsentError } from "~/lib/queries/agent-access"
import { UnsafeConsentRedirectError, useAgentConsent } from "~/lib/oauth/use-agent-consent"

const EXPIRED_MESSAGE = "This request expired. Start the connection again from your agent."

/** The OAuth consent screen an agent opens to connect to a Doxa account. */
export function ConsentPage({ consentId }: { consentId: string }) {
  const { consent, decision } = useAgentConsent(consentId)

  if (consentId.length === 0 || isExpiredConsentError(consent.error) || isExpiredConsentError(decision.error)) {
    return <ConsentMessage title="Request expired" description={EXPIRED_MESSAGE} />
  }

  if (consent.isPending) {
    return <ConsentMessage title="Allow access" description="Loading the request…" loading />
  }

  if (consent.isError) {
    return (
      <ConsentMessage
        title="Allow access"
        description="Could not load this request."
        action={(
          <Button variant="outline" className="h-11 w-full" onClick={() => void consent.refetch()}>
            Try again
          </Button>
        )}
      />
    )
  }

  return (
    <AuthCard className="max-w-lg items-stretch">
      <ConsentCardHeader title="Allow access" />
      <ConsentForm
        details={consent.data}
        decisionState={decisionStateOf(decision)}
        decisionError={decisionErrorMessage(decision.error)}
        onDecide={(request) => decision.mutate(request)}
      />
    </AuthCard>
  )
}

function decisionStateOf(decision: {
  isPending: boolean
  isSuccess: boolean
  variables: { kind: "approve" | "deny" } | undefined
}): ConsentDecisionState {
  if (decision.isSuccess) return "leaving"
  if (!decision.isPending) return "idle"
  return decision.variables?.kind === "deny" ? "denying" : "approving"
}

function decisionErrorMessage(error: Error | null): string | null {
  if (error === null) return null
  if (error instanceof UnsafeConsentRedirectError) return error.message
  return "Could not save your choice. Try again."
}
