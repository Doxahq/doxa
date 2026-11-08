import type { DoxabotSettingsDto, UpdateDoxabotSettingsInput } from "@doxahq/contracts"
import { GitMerge } from "lucide-react"
import { toast } from "sonner"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import {
  MERGE_TRIGGER_OPTIONS,
  QUIET_TIME_OPTIONS,
  parseQuietMinutes,
} from "~/lib/dashboard/doxabot-merge-model"
import { getErrorMessage } from "~/lib/errors"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectDoxabot } from "~/lib/dashboard/use-project-doxabot"
import { cn } from "~/lib/utils"

/**
 * The merge setting of the Doxabot page. It is set on its own: merge updates
 * run with pull request previews on or off.
 */
export function DoxabotMergeUpdatesCard({ projectId }: { projectId: string }) {
  const state = useProjectDoxabot(projectId)
  // A merge update starts a generation, so the choice needs `generation.run`.
  const canChange = useProjectCapabilities(projectId).can("generation.run")
  const settings = state.settings

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-3">
          <GitMerge aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3 id="doxabot-merge-updates">When a pull request merges</h3>
            </CardTitle>
            <CardDescription>
              Choose when Doxa updates your docs after code merges into the production branch. Updates always go
              to a review before they go live.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 border-t border-border pt-4">
        {settings?.available ? (
          <DoxabotMergeTrigger
            settings={settings}
            disabled={!canChange || state.isSaving}
            onUpdate={state.update}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Merge updates need the same setup as pull request previews. The previews card shows what is missing.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * When a merge into the production branch updates the docs. Every update goes
 * to a review, so no choice changes the live site by itself.
 */
export function DoxabotMergeTrigger(props: {
  settings: DoxabotSettingsDto
  disabled: boolean
  onUpdate: (changes: UpdateDoxabotSettingsInput) => Promise<unknown>
}) {
  async function save(changes: UpdateDoxabotSettingsInput): Promise<void> {
    try {
      await props.onUpdate(changes)
      toast.success("Merge setting saved")
    } catch (caught) {
      toast.error(getErrorMessage(caught, "Failed to save the merge setting."))
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div role="radiogroup" aria-labelledby="doxabot-merge-updates" className="flex flex-col border border-border">
        {MERGE_TRIGGER_OPTIONS.map((option) => {
          const selected = props.settings.mergeTrigger === option.value
          return (
            <div
              key={option.value}
              className={cn("flex flex-col gap-2 border-t border-border px-4 py-3 first:border-t-0", selected && "bg-primary-wash")}
            >
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={props.disabled}
                onClick={() => {
                  if (!selected) void save({ mergeTrigger: option.value })
                }}
                className="flex items-start gap-3 text-left disabled:opacity-60"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1 size-3.5 shrink-0 rounded-full border",
                    selected ? "border-primary bg-primary" : "border-border",
                  )}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">{option.title}</span>
                  <span className="text-[13px] text-muted-foreground">{option.description}</span>
                </span>
              </button>
              {option.value === "batched" && selected ? (
                <label className="ml-6.5 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                  Wait
                  <Select
                    value={String(props.settings.batchQuietMinutes)}
                    disabled={props.disabled}
                    onValueChange={(value) => {
                      const minutes = parseQuietMinutes(value)
                      if (minutes !== null) void save({ batchQuietMinutes: minutes })
                    }}
                  >
                    <SelectTrigger className="h-8 w-36" aria-label="Wait after the last merge">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUIET_TIME_OPTIONS.map((quiet) => (
                        <SelectItem key={quiet.value} value={String(quiet.value)}>
                          {quiet.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  after the last merge
                </label>
              ) : null}
            </div>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        This setting does not depend on pull request previews. Each one is turned on or off on its own.
      </p>
    </section>
  )
}
