import { useState } from "react"
import { Bot } from "lucide-react"

import {
  EmptyState,
  SectionDescription,
  SectionLabel,
} from "~/components/dashboard/dashboard-header"
import { ConnectedAgentRow } from "~/components/dashboard/settings/connected-agent-row"
import { useConnectedAgents } from "~/lib/dashboard/use-connected-agents"

/** The agents (MCP clients) that can use the account, with a revoke action. */
export function ConnectedAgentsSection() {
  const { grants, isLoading, loadError, revoke, revokingGrantId, revokeError } = useConnectedAgents()
  const [confirmingGrantId, setConfirmingGrantId] = useState<string | null>(null)

  async function confirmRevoke(grantId: string) {
    try {
      await revoke(grantId)
      setConfirmingGrantId(null)
    } catch {
      // The hook exposes the error as `revokeError`; the row stays open to retry.
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionLabel>Connected agents</SectionLabel>
        <SectionDescription>Agents that can use your Doxa account through MCP.</SectionDescription>
      </div>

      {isLoading ? (
        <p className="surface-card px-5 py-4 text-sm text-muted-foreground">Loading connected agents…</p>
      ) : loadError ? (
        <p role="alert" className="surface-card px-5 py-4 text-sm text-destructive">{loadError}</p>
      ) : grants.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="No connected agents"
          description="Connect an agent from its MCP settings. It shows up here."
        />
      ) : (
        <ul className="surface-card">
          {grants.map((grant) => (
            <ConnectedAgentRow
              key={grant.grantId}
              grant={grant}
              isConfirming={confirmingGrantId === grant.grantId}
              isRevoking={revokingGrantId === grant.grantId}
              revokeDisabled={revokingGrantId !== null}
              onAskRevoke={() => setConfirmingGrantId(grant.grantId)}
              onCancelRevoke={() => setConfirmingGrantId(null)}
              onConfirmRevoke={() => void confirmRevoke(grant.grantId)}
            />
          ))}
        </ul>
      )}

      {revokeError ? <p role="alert" className="text-sm text-destructive">{revokeError}</p> : null}
    </section>
  )
}
