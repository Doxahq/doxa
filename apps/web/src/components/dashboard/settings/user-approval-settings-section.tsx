import { SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import {
  ApprovalModeRows,
  ApprovalSettingsFooter,
  ApprovalSettingsList,
} from "~/components/dashboard/settings/approval-settings-list"
import { useUserApprovalSettings } from "~/lib/dashboard/use-approval-settings"

/** Account settings → Agent approvals: the user's defaults for every project. */
export function UserApprovalSettingsSection() {
  const state = useUserApprovalSettings()

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionLabel>Agent approvals</SectionLabel>
        <SectionDescription>
          What your agents can do without asking you, in every project. A project setting wins over these defaults.
        </SectionDescription>
      </div>

      {state.isLoading ? (
        <p className="surface-card px-5 py-4 text-sm text-muted-foreground">Loading approval settings…</p>
      ) : state.loadError ? (
        <p role="alert" className="surface-card px-5 py-4 text-sm text-destructive">{state.loadError}</p>
      ) : state.settings ? (
        <>
          <ApprovalSettingsList>
            <ApprovalModeRows
              actions={state.settings.actions}
              modeOf={state.modeOf}
              onSelect={state.selectMode}
              disabled={state.isSaving}
            />
          </ApprovalSettingsList>
          <ApprovalSettingsFooter
            canSave={state.isDirty}
            isSaving={state.isSaving}
            error={state.saveError}
            onSave={state.save}
          />
        </>
      ) : null}
    </section>
  )
}
