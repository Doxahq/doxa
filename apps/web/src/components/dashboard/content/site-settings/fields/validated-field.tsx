import { useId, type ReactNode } from "react"

import { Label } from "~/components/ui/label"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import {
  fieldIdForPointer,
  issuesAt,
  issuesWithin,
} from "~/lib/dashboard/site-settings-issues"
import { cn } from "~/lib/utils"

/** One message under a field: an issue, or a local problem such as a failed upload. */
export interface FieldMessage {
  message: string
  severity: "error" | "warning"
}

/** The accessibility wiring a control spreads onto itself. */
export interface FieldControlProps {
  id: string
  "aria-invalid": boolean
  "aria-describedby": string | undefined
  onBlur: () => void
}

interface ValidatedFieldProps {
  /** The JSON pointer of the setting this field edits. */
  pointer: string
  label: string
  description?: ReactNode
  /** Controls on the right of the label, for example a reset button. */
  actions?: ReactNode
  /** Messages from outside the config, for example a failed upload. */
  extraIssues?: readonly FieldMessage[]
  /** Also shows issues of nested values, for list fields such as keywords. */
  includeNested?: boolean
  className?: string
  children: (control: FieldControlProps) => ReactNode
}

/**
 * One labelled setting with its messages.
 *
 * An error shows after the first blur of the field, or after the first save
 * attempt. A server issue shows at once, because the person already saved.
 */
export function ValidatedField({
  pointer,
  label,
  description,
  actions,
  extraIssues = [],
  includeNested = false,
  className,
  children,
}: ValidatedFieldProps) {
  const { state } = useSiteSettingsContext()
  const messageId = useId()
  const descriptionId = useId()
  const id = fieldIdForPointer(pointer)
  const issues: readonly FieldMessage[] = [
    ...extraIssues,
    ...(includeNested ? issuesWithin(state.issues, pointer) : issuesAt(state.issues, pointer)).filter(
      state.isIssueVisible,
    ),
  ]
  const hasError = issues.some((issue) => issue.severity === "error")
  const describedBy = [description ? descriptionId : null, issues.length > 0 ? messageId : null]
    .filter(Boolean)
    .join(" ")

  // A wide field puts its label in a 200px column beside the control. A narrow
  // one, for example inside a two-column grid or on a phone, stacks them.
  return (
    <div className={cn("@container", className)}>
      <div className="grid items-start gap-1.5 @[560px]:grid-cols-[200px_minmax(0,1fr)] @[560px]:gap-x-6">
        <div className="flex min-h-5 items-center justify-between gap-3 @[560px]:min-h-9 @[560px]:flex-col @[560px]:items-start @[560px]:justify-center @[560px]:gap-1">
          <Label htmlFor={id}>{label}</Label>
          {actions}
        </div>
        <div className="min-w-0 space-y-1.5">
          {children({
            id,
            "aria-invalid": hasError,
            "aria-describedby": describedBy || undefined,
            onBlur: () => state.markTouched(pointer),
          })}
          {description ? (
            <p id={descriptionId} className="text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
          <FieldMessages id={messageId} issues={issues} />
        </div>
      </div>
    </div>
  )
}

export function FieldMessages({
  id,
  issues,
}: {
  id?: string
  issues: readonly FieldMessage[]
}) {
  if (issues.length === 0) return null
  return (
    <ul id={id} className="space-y-0.5">
      {issues.map((issue, index) => (
        <li
          key={`${index}:${issue.message}`}
          className={cn(
            "text-xs leading-5",
            issue.severity === "error" ? "text-destructive" : "text-warning",
          )}
        >
          {issue.message}
        </li>
      ))}
    </ul>
  )
}
