import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"
import type { AgentActionKind } from "@doxahq/contracts/approval-requests"
import type { ApprovalActionSetting, ApprovalMode } from "@doxahq/contracts/approval-settings"

import { SegmentedControl } from "~/components/dashboard/content/site-settings/fields/controls"
import { Button } from "~/components/ui/button"
import { actionNote, approvalModeOptions } from "~/lib/dashboard/approval-settings-model"

/** A bordered list of settings rows, as in the spec mock. */
export function ApprovalSettingsList({ children }: { children: ReactNode }) {
  return <ul className="surface-card divide-y divide-border">{children}</ul>
}

/** One row: what the setting is on the left, its control on the right. */
export function ApprovalSettingsRow({
  title,
  detail,
  control,
}: {
  title: string
  detail: ReactNode
  control: ReactNode
}) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      <div className="shrink-0">{control}</div>
    </li>
  )
}

/** One row per action, offering only its allowed modes. */
export function ApprovalModeRows({
  actions,
  modeOf,
  onSelect,
  disabled,
}: {
  actions: readonly ApprovalActionSetting[]
  modeOf: (setting: ApprovalActionSetting) => ApprovalMode
  onSelect: (kind: AgentActionKind, mode: ApprovalMode) => void
  disabled: boolean
}) {
  return actions.map((setting) => {
    const note = actionNote(setting)
    return (
      <ApprovalSettingsRow
        key={setting.actionKind}
        title={setting.title}
        detail={
          <>
            <span className="font-mono">{setting.actionKind}</span>
            {note ? ` · ${note}` : null}
          </>
        }
        control={
          <SegmentedControl
            label={setting.title}
            value={modeOf(setting)}
            options={approvalModeOptions(setting)}
            onValueChange={(mode) => onSelect(setting.actionKind, mode)}
            disabled={disabled}
          />
        }
      />
    )
  })
}

/** The rule reminder and the Save button under the list. */
export function ApprovalSettingsFooter({
  canSave,
  isSaving,
  error,
  onSave,
}: {
  canSave: boolean
  isSaving: boolean
  error: string | null
  onSave: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Changes apply to new requests. Pending requests keep their mode.</p>
        <Button type="button" size="sm" disabled={!canSave || isSaving} onClick={onSave}>
          {isSaving ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Save
        </Button>
      </div>
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    </div>
  )
}
