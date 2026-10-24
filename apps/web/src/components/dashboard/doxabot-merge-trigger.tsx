import type { DoxabotSettingsDto, UpdateDoxabotSettingsInput } from "@doxahq/contracts"
import { toast } from "sonner"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
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
import { cn } from "~/lib/utils"

/**
 * When a merge into the default branch updates the docs. Every update goes
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
      <div className="flex flex-col gap-1">
        <SectionLabel>When a pull request merges</SectionLabel>
        <p className="text-sm text-muted-foreground">
          Choose when Doxa updates your docs after code merges. Updates always go to a review before they go live.
        </p>
      </div>
      <div role="radiogroup" aria-label="When a pull request merges" className="flex flex-col border border-border">
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
      <p className="text-xs text-muted-foreground">Previews for open pull requests are not affected by this setting.</p>
    </section>
  )
}
