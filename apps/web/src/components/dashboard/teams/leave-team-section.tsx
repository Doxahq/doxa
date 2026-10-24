import { useId, useState } from "react"
import { Info, Loader2 } from "lucide-react"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { Button } from "~/components/ui/button"
import { LEAVE_BLOCK_NOTES, type LeaveBlockReason } from "~/lib/dashboard/teams-model"

/** Leaves the team after a confirm step, unless the user is its last owner. */
export function LeaveTeamSection({
  blockReason,
  isLeaving,
  onLeave,
}: {
  blockReason: LeaveBlockReason | null
  isLeaving: boolean
  onLeave: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const noteId = useId()
  const isBlocked = blockReason !== null
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Leave team</SectionLabel>
      <div className="surface-card flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            You and your agents lose access to the team's projects at once. The last owner cannot leave.
          </p>
          {confirming && !isBlocked ? (
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={isLeaving} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" size="sm" disabled={isLeaving} onClick={onLeave}>
                {isLeaving ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                Leave team
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit shrink-0"
              disabled={isBlocked}
              aria-describedby={isBlocked ? noteId : undefined}
              onClick={() => setConfirming(true)}
            >
              Leave team
            </Button>
          )}
        </div>
        {blockReason ? (
          <p id={noteId} className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            {LEAVE_BLOCK_NOTES[blockReason]}
          </p>
        ) : null}
      </div>
    </section>
  )
}
