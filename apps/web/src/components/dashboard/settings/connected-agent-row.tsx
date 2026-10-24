import { Loader2 } from "lucide-react"
import type { AgentGrantSummary } from "@doxahq/contracts/agent-access"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { formatGrantDate, formatGrantProjectScope } from "~/lib/dashboard/connected-agents-model"

/**
 * One connected agent. "Revoke" first asks for a confirmation inside the row,
 * because revoking ends the agent's access at once.
 */
export function ConnectedAgentRow({
  grant,
  isConfirming,
  isRevoking,
  revokeDisabled,
  onAskRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: {
  grant: AgentGrantSummary
  isConfirming: boolean
  isRevoking: boolean
  revokeDisabled: boolean
  onAskRevoke: () => void
  onCancelRevoke: () => void
  onConfirmRevoke: () => void
}) {
  return (
    <li className="flex flex-col gap-3 border-t border-divider px-5 py-4 first:border-t-0">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="truncate text-[14.5px] font-medium text-foreground">{grant.clientName}</p>
          <p className="text-xs text-muted-foreground">
            {formatGrantProjectScope(grant.projectScope)}
            {" · "}Connected {formatGrantDate(grant.createdAt)}
            {" · "}Last activity {formatGrantDate(grant.lastActivityAt)}
          </p>
          <ul aria-label="Permissions" className="flex flex-wrap gap-1.5 pt-1">
            {grant.scopes.map((scope) => (
              <li key={scope}>
                <Badge variant="muted">{scope}</Badge>
              </li>
            ))}
          </ul>
        </div>
        {isConfirming ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={revokeDisabled}
            onClick={onAskRevoke}
          >
            Revoke
          </Button>
        )}
      </div>

      {isConfirming ? (
        <div
          role="group"
          aria-label={`Revoke ${grant.clientName}`}
          className="flex flex-col gap-3 border border-destructive/40 bg-destructive/8 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-foreground">
            Revoke access for {grant.clientName}? It stops working at once.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={isRevoking} onClick={onCancelRevoke}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" size="sm" disabled={isRevoking} onClick={onConfirmRevoke}>
              {isRevoking ? <Loader2 className="animate-spin" /> : null}
              Revoke access
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
