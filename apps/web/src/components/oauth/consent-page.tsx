import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"

import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { LogoMark } from "~/components/navigation/logo"
import { ConsentForm, type ConsentDecisionState } from "~/components/oauth/consent-form"
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

function ConsentCardHeader({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <LogoMark size={32} />
      <AuthCardHeading title={title} />
    </div>
  )
}

function ConsentMessage({
  title,
  description,
  loading = false,
  action,
}: {
  title: string
  description: string
  loading?: boolean
  action?: ReactNode
}) {
  return (
    <AuthCard>
      <ConsentCardHeader title={title} />
      <div role="status" className="flex items-center gap-2.5 text-center text-sm text-muted-foreground">
        {loading ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
        <p>{description}</p>
      </div>
      {action}
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
