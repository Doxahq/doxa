import { useState } from "react"
import { AlertCircle, ChevronDown, TriangleAlert } from "lucide-react"

import {
  describePointer,
  SITE_SETTINGS_TAB_LABELS,
  tabForIssue,
  type SettingsIssue,
} from "~/lib/dashboard/site-settings-issues"
import { cn } from "~/lib/utils"

interface IssueSummaryProps {
  issues: readonly SettingsIssue[]
  /** Starts open, for example after a rejected publish. */
  defaultOpen?: boolean
  /** Stays open while errors need attention, for example during a close. */
  forceOpen: boolean
  onNavigate: (issue: SettingsIssue) => void
}

/**
 * Every problem in one list, with a link to the field that causes it.
 *
 * It is a polite live region, so a screen reader announces a change in the
 * count without interrupting the person.
 */
export function IssueSummary({ issues, defaultOpen = false, forceOpen, onNavigate }: IssueSummaryProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const errors = issues.filter((issue) => issue.severity === "error").length
  const warnings = issues.length - errors
  if (issues.length === 0) return null
  const expanded = isOpen || (forceOpen && errors > 0)
  const counts = [
    errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : null,
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("rounded-lg border", errors > 0 ? "border-destructive/50 bg-destructive/5" : "border-warning/40 bg-warning/5")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setIsOpen(!expanded)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left focus-visible:-outline-offset-2"
      >
        <span className="flex items-center gap-2 text-sm">
          {errors > 0 ? (
            <AlertCircle aria-hidden="true" className="size-4 text-destructive" />
          ) : (
            <TriangleAlert aria-hidden="true" className="size-4 text-warning" />
          )}
          {counts}
        </span>
        <ChevronDown aria-hidden="true" className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <ul className="max-h-48 overflow-y-auto border-t border-border/60 scrollbar-subtle">
          {issues.map((issue, index) => {
            const tab = tabForIssue(issue)
            return (
              <li key={`${issue.path}:${issue.code}:${index}`} className="border-t border-border/40 first:border-t-0">
                <button
                  type="button"
                  onClick={() => onNavigate(issue)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/30 focus-visible:-outline-offset-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn("mt-1.5 size-1.5 shrink-0", issue.severity === "error" ? "bg-destructive" : "bg-warning")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[11px] text-foreground">
                      {describePointer(issue.path)}
                    </span>
                    <span className="block text-xs leading-5 text-muted-foreground">{issue.message}</span>
                  </span>
                  <span className="shrink-0 text-xs text-primary">
                    {tab === "json" ? "Show in JSON" : `Go to ${SITE_SETTINGS_TAB_LABELS[tab]}`}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
