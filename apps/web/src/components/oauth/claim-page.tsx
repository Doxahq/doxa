import { AuthCard } from "~/components/auth/auth-card"
import { ClaimForm, type ClaimDecisionState } from "~/components/oauth/claim-form"
import { ConsentCardHeader, ConsentMessage } from "~/components/oauth/consent-message"
import { Button } from "~/components/ui/button"
import { ApiRequestError } from "~/lib/api-errors"
import { useAgentClaim } from "~/lib/oauth/use-agent-claim"
import { isExpiredConsentError } from "~/lib/queries/agent-access"

const TITLE = "Connect your agent"
const EXPIRED_MESSAGE = "This setup link expired. Ask your agent to start the setup again."
/** Statuses where the API message tells the person what to do. */
const USER_FIXABLE_STATUSES: ReadonlySet<number> = new Set([400, 403, 409])

/** The page that an agent sends a person to, to approve the agent with a setup code. */
export function ClaimPage({ attemptToken, signedIn }: { attemptToken: string; signedIn: boolean }) {
  const { opened, details, decision } = useAgentClaim(attemptToken, signedIn)

  if (
    attemptToken.length === 0 ||
    isExpiredConsentError(opened.error) ||
    isExpiredConsentError(details.error) ||
    isExpiredConsentError(decision.error)
  ) {
    return <ConsentMessage title="Setup link expired" description={EXPIRED_MESSAGE} />
  }

  if (decision.isSuccess) {
    return decision.variables.kind === "approve" ? (
      <ConsentMessage title="Agent connected" description="Go back to your agent. It finishes the setup." />
    ) : (
      <ConsentMessage title="Request denied" description="The agent did not get access to your account." />
    )
  }

  if (opened.isError || details.isError) {
    return (
      <ConsentMessage
        title={TITLE}
        description="Could not load this request."
        action={(
          <Button
            variant="outline"
            className="h-11 w-full"
            onClick={() => void (opened.isError ? opened.refetch() : details.refetch())}
          >
            Try again
          </Button>
        )}
      />
    )
  }

  if (details.data === undefined) {
    return <ConsentMessage title={TITLE} description="Loading the request…" loading />
  }

  if (!details.data.accountMatches) {
    return (
      <ConsentMessage
        title="Use a different account"
        description={`Your agent started this setup for ${details.data.loginHint}. Sign out, then open the link again and sign in with that account.`}
      />
    )
  }

  return (
    <AuthCard className="max-w-4xl items-stretch gap-6 py-8">
      <ConsentCardHeader title={TITLE} />
      <ClaimForm
        details={details.data}
        decisionState={decisionStateOf(decision)}
        decisionError={decisionErrorMessage(decision.error)}
        onDecide={(request) => decision.mutate(request)}
      />
    </AuthCard>
  )
}

function decisionStateOf(decision: {
  isPending: boolean
  variables: { kind: "approve" | "deny" } | undefined
}): ClaimDecisionState {
  if (!decision.isPending) return "idle"
  return decision.variables?.kind === "deny" ? "denying" : "approving"
}

function decisionErrorMessage(error: Error | null): string | null {
  if (error === null) return null
  if (error instanceof ApiRequestError && USER_FIXABLE_STATUSES.has(error.status)) return error.message
  return "Could not save your choice. Try again."
}
