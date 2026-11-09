import { useMemo, useState } from "react"
import { Loader2, ShieldAlert } from "lucide-react"
import type { AgentClaimDetails, OAuthScope } from "@doxahq/contracts/agent-access"

import { ConsentProjectPicker } from "~/components/oauth/consent-project-picker"
import { ConsentScopeList } from "~/components/oauth/consent-scope-list"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { isCompleteUserCode, normalizeUserCode } from "~/lib/oauth/claim-model"
import {
  buildApproveInput,
  offeredScopes,
  projectChoiceIssue,
  scopeOptions,
  type ProjectChoice,
} from "~/lib/oauth/consent-model"
import type { ClaimDecisionRequest } from "~/lib/oauth/use-agent-claim"

export type ClaimDecisionState = "idle" | "approving" | "denying"

/** The setup code, the access choices, and the Allow and Deny buttons. */
export function ClaimForm({
  details,
  decisionState,
  decisionError,
  onDecide,
}: {
  details: AgentClaimDetails
  decisionState: ClaimDecisionState
  decisionError: string | null
  onDecide: (request: ClaimDecisionRequest) => void
}) {
  const offered = useMemo(() => offeredScopes(details.requestedScopes), [details.requestedScopes])
  const [userCode, setUserCode] = useState("")
  const [chosen, setChosen] = useState<ReadonlySet<OAuthScope>>(() => new Set(offered))
  // The person started this setup and wants the agent to work across the account,
  // so every requested permission and all projects are the default.
  const [projectChoice, setProjectChoice] = useState<ProjectChoice>({ kind: "all" })

  const busy = decisionState !== "idle"
  const approveInput = buildApproveInput(offered, chosen, projectChoice)
  const canApprove = approveInput !== null && isCompleteUserCode(userCode)

  function toggleScope(scope: OAuthScope, checked: boolean) {
    setChosen((current) => {
      const next = new Set(current)
      if (checked) next.add(scope)
      else next.delete(scope)
      return next
    })
  }

  return (
    <form
      className="grid w-full gap-6 md:grid-cols-2 md:gap-8"
      onSubmit={(event) => {
        event.preventDefault()
        if (approveInput && canApprove) onDecide({ kind: "approve", input: { ...approveInput, userCode } })
      }}
    >
      <div className="flex min-w-0 flex-col gap-6">
        <ClaimAgentIdentity clientName={details.clientName} tokenName={details.tokenName} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="claim-user-code">Setup code</Label>
          <Input
            id="claim-user-code"
            value={userCode}
            onChange={(event) => setUserCode(normalizeUserCode(event.target.value))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="123456"
            disabled={busy}
            className="h-11 text-center font-mono text-lg tracking-[0.4em]"
          />
          <p className="text-xs text-muted-foreground">
            Find this code in your agent chat. Doxa does not send it by email.
          </p>
        </div>

        <ConsentProjectPicker
          projects={details.projects}
          choice={projectChoice}
          issue={projectChoiceIssue(projectChoice)}
          disabled={busy}
          onChange={setProjectChoice}
        />
      </div>

      <div className="flex min-w-0 flex-col justify-between gap-6">
        <ConsentScopeList options={scopeOptions(offered, chosen)} disabled={busy} onToggle={toggleScope} />

        <div className="flex flex-col gap-3">
          {decisionError ? (
            <p role="alert" className="text-sm text-destructive">{decisionError}</p>
          ) : null}
          <div className="grid grid-cols-2 gap-2.5">
            <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => onDecide({ kind: "deny" })}>
              {decisionState === "denying" ? <Loader2 className="animate-spin" /> : null}
              Deny
            </Button>
            <Button type="submit" className="h-11" disabled={busy || !canApprove}>
              {decisionState === "approving" ? <Loader2 className="animate-spin" /> : null}
              Allow
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

function ClaimAgentIdentity({ clientName, tokenName }: { clientName: string; tokenName: string }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="min-w-0 text-2xl leading-tight font-semibold break-words text-foreground">{clientName}</p>
          <Badge variant="warning">unverified</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          wants to use your Doxa account. Its token will be named{" "}
          <span className="font-mono break-words text-body">{tokenName}</span>.
        </p>
      </div>
      <div className="flex gap-2.5 border border-warning/35 bg-warning/8 px-3.5 py-3 text-sm text-warning">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          Doxa cannot check this agent. It chose its own name. Continue only if you started this setup
          yourself.
        </p>
      </div>
    </div>
  )
}
