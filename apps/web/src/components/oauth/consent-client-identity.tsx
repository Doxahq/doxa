import { ShieldAlert } from "lucide-react"
import type { AgentConsentClient } from "@doxahq/contracts/agent-access"

import { Badge } from "~/components/ui/badge"

/**
 * Who asks for access and where the browser goes next, in large text, so a
 * person can spot a look-alike agent before they allow it.
 */
export function ConsentClientIdentity({ client }: { client: AgentConsentClient }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="min-w-0 text-2xl leading-tight font-semibold break-words text-foreground">
            {client.name}
          </p>
          {/* The host, not the word "verified": any domain can publish a
              metadata document that names itself "Claude" (SEC-013). */}
          {client.verified && client.metadataUrl ? (
            <Badge variant="outline" className="font-mono">{hostOf(client.metadataUrl)}</Badge>
          ) : (
            <Badge variant="warning">unverified</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">wants to use your Doxa account.</p>
        {client.verified && client.metadataUrl ? (
          <p className="text-xs text-muted-foreground">
            The agent chose this name. Doxa checked only that it comes from{" "}
            <span className="font-mono break-all text-body">{hostOf(client.metadataUrl)}</span>.
          </p>
        ) : null}
      </div>

      {client.verified ? null : <UnverifiedClientWarning />}

      <div className="flex flex-col gap-1.5 border-t border-divider pt-5">
        <p className="text-sm text-muted-foreground">After you allow, you go back to</p>
        <p className="font-mono text-lg font-semibold break-all text-foreground">
          {client.redirectHost}
        </p>
      </div>
    </div>
  )
}

function UnverifiedClientWarning() {
  return (
    <div className="flex gap-2.5 border border-warning/35 bg-warning/8 px-3.5 py-3 text-sm text-warning">
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>
        Doxa cannot check this agent. It chose its own name. Allow it only if you started this
        connection.
      </p>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
