import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "~/components/ui/button"
import { useRevokeProjectAgent } from "~/lib/dashboard/use-agent-activity"

/** Revoking cannot be undone, so the first click only asks. */
export function AgentRevokeControl({
  projectId,
  grantRef,
  agentName,
}: {
  projectId: string
  grantRef: string
  agentName: string
}) {
  const [confirming, setConfirming] = useState(false)
  const revoke = useRevokeProjectAgent(projectId)

  if (!confirming) {
    return (
      <Button type="button" variant="outline" className="w-full text-destructive" onClick={() => setConfirming(true)}>
        Revoke agent access
      </Button>
    )
  }

  function confirm() {
    revoke.mutate(grantRef, {
      onSuccess: () => toast.success(`${agentName} no longer has access`),
      onError: () => toast.error("Could not revoke access. Try again."),
      onSettled: () => setConfirming(false),
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-muted-foreground">{agentName} loses access at once. It cannot make more changes.</p>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" disabled={revoke.isPending} onClick={confirm}>
          {revoke.isPending ? <Loader2 className="animate-spin" /> : null}
          Revoke
        </Button>
      </div>
    </div>
  )
}
