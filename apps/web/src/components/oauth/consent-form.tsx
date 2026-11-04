import { useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import type { AgentConsentDetails, OAuthScope } from "@doxahq/contracts/agent-access"

import { ConsentClientIdentity } from "~/components/oauth/consent-client-identity"
import { ConsentProjectPicker } from "~/components/oauth/consent-project-picker"
import { ConsentScopeList } from "~/components/oauth/consent-scope-list"
import { Button } from "~/components/ui/button"
import {
  buildApproveInput,
  initialProjectChoice,
  initialScopes,
  offeredScopes,
  projectChoiceIssue,
  scopeOptions,
  type ProjectChoice,
} from "~/lib/oauth/consent-model"
import type { ConsentDecisionRequest } from "~/lib/oauth/use-agent-consent"

export type ConsentDecisionState = "idle" | "approving" | "denying" | "leaving"

/** The consent choices and the Allow and Deny buttons. */
export function ConsentForm({
  details,
  decisionState,
  decisionError,
  onDecide,
}: {
  details: AgentConsentDetails
  decisionState: ConsentDecisionState
  decisionError: string | null
  onDecide: (request: ConsentDecisionRequest) => void
}) {
  const offered = useMemo(() => offeredScopes(details.requestedScopes), [details.requestedScopes])
  const [chosen, setChosen] = useState<ReadonlySet<OAuthScope>>(() => initialScopes(offered))
  const [projectChoice, setProjectChoice] = useState<ProjectChoice>(() =>
    initialProjectChoice(details.projects.map((project) => project.id)),
  )

  const busy = decisionState !== "idle"
  const options = scopeOptions(offered, chosen)
  const projectIssue = projectChoiceIssue(projectChoice)
  const approveInput = buildApproveInput(offered, chosen, projectChoice)

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
      className="flex w-full flex-col gap-7"
      onSubmit={(event) => {
        event.preventDefault()
        if (approveInput) onDecide({ kind: "approve", input: approveInput })
      }}
    >
      <ConsentClientIdentity client={details.client} />
      <ConsentScopeList options={options} disabled={busy} onToggle={toggleScope} />
      <ConsentProjectPicker
        projects={details.projects}
        choice={projectChoice}
        issue={projectIssue}
        disabled={busy}
        onChange={setProjectChoice}
      />

      <div className="flex flex-col gap-3">
        {decisionError ? (
          <p role="alert" className="text-sm text-destructive">{decisionError}</p>
        ) : null}
        {decisionState === "leaving" ? (
          <p className="text-sm text-muted-foreground">
            Going back to <span className="font-mono text-foreground">{details.client.redirectHost}</span>…
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2.5">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={busy}
            onClick={() => onDecide({ kind: "deny" })}
          >
            {decisionState === "denying" ? <Loader2 className="animate-spin" /> : null}
            Deny
          </Button>
          <Button type="submit" className="h-11" disabled={busy || approveInput === null}>
            {decisionState === "approving" ? <Loader2 className="animate-spin" /> : null}
            Allow
          </Button>
        </div>
      </div>
    </form>
  )
}
