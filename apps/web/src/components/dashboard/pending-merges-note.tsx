import type { DoxabotSettingsDto, PendingMerges } from "@doxahq/contracts"
import { GitMerge } from "lucide-react"

import { plural } from "~/components/dashboard/content/branches/publish-menu-parts"
import { Button } from "~/components/ui/button"
import { pendingMergesNextStep } from "~/lib/dashboard/doxabot-merge-model"

/**
 * Pull requests that merged after the last production generation started,
 * and what Doxa does with them next.
 */
export function PendingMergesNote(props: {
  merges: PendingMerges["merges"]
  settings: DoxabotSettingsDto | null
  onGenerate: (() => void) | null
}) {
  if (props.merges.length === 0) return null
  const numbers = props.merges.slice(0, 5).map((merge) => `#${merge.number}`).join(", ")
  const more = props.merges.length > 5 ? ` and ${props.merges.length - 5} more` : ""

  return (
    <div className="surface-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <GitMerge aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">
            {plural(props.merges.length, "merged pull request")} not in your docs yet
          </p>
          <p className="text-sm text-muted-foreground">
            {numbers}
            {more}. {props.settings ? pendingMergesNextStep(props.settings) : "Generate to bring them into your docs."}
          </p>
        </div>
      </div>
      {props.onGenerate ? (
        <Button size="sm" variant="outline" className="shrink-0" onClick={props.onGenerate}>
          Generate
        </Button>
      ) : null}
    </div>
  )
}
