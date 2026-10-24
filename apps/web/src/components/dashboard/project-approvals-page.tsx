import { Link } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"

import { SegmentedControl } from "~/components/dashboard/content/site-settings/fields/controls"
import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { PageBackNavigation } from "~/components/dashboard/page-back-navigation"
import {
  ApprovalModeRows,
  ApprovalSettingsFooter,
  ApprovalSettingsList,
  ApprovalSettingsRow,
} from "~/components/dashboard/settings/approval-settings-list"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Checkbox } from "~/components/ui/checkbox"
import { ERASE_OPTIONS } from "~/lib/dashboard/approval-settings-model"
import { ProjectApprovalsSkeleton } from "~/components/dashboard/skeletons/settings-skeletons"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { useProjectApprovalSettings } from "~/lib/dashboard/use-approval-settings"

/** Project settings → Agent approvals (MCP v2 spec §4). */
export function ProjectApprovalsPage({ projectId }: { projectId: string }) {
  const state = useProjectApprovalSettings(projectId)
  const settings = state.settings
  const readOnly = settings === null || !settings.canConfigure || state.isSaving

  // The skeleton is for the first load only (see `useIsFirstLoad`).
  const isFirstLoad = useIsFirstLoad([{ isPending: state.isLoading }])
  if (isFirstLoad) return <ProjectApprovalsSkeleton />

  return (
    <PageBody className="max-w-3xl">
      <PageBackNavigation>
        <Link to="/dashboard/projects/$projectId/settings" params={{ projectId }}>
          <ArrowLeft aria-hidden="true" />
          Settings
        </Link>
      </PageBackNavigation>
      <PageHeading
        label="Project settings"
        title="Agent approvals"
        description="What agents can do in this project without asking you. These settings win over each member's own defaults."
      />

      {state.loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{state.loadError}</AlertDescription>
        </Alert>
      ) : null}
      {settings ? (
        <section className="flex flex-col gap-4">
          {settings.canConfigure ? null : (
            <Alert>
              <AlertDescription>Only a project admin can change these settings.</AlertDescription>
            </Alert>
          )}
          <ApprovalSettingsList>
            <ApprovalModeRows
              actions={settings.actions}
              modeOf={state.modeOf}
              onSelect={state.selectMode}
              disabled={readOnly}
            />
            <ApprovalSettingsRow
              title="Erase the branch after an approved publish"
              detail="Default of the checkbox in the approve panel"
              control={
                <SegmentedControl
                  label="Erase the branch after an approved publish"
                  value={state.eraseBranchAfterPublish ? "erase" : "keep"}
                  options={ERASE_OPTIONS}
                  onValueChange={(value) => state.setEraseBranchAfterPublish(value === "erase")}
                  disabled={readOnly}
                />
              }
            />
            <ApprovalSettingsRow
              title="Require another member to approve"
              detail="A member cannot approve a request from their own agent. They can still reject it."
              control={
                <label className="flex items-center gap-2 text-sm text-foreground has-disabled:cursor-default">
                  <Checkbox
                    aria-label="Require another member to approve"
                    checked={state.requireOtherDecider}
                    disabled={readOnly}
                    onChange={(event) => state.setRequireOtherDecider(event.target.checked)}
                  />
                  Required
                </label>
              }
            />
          </ApprovalSettingsList>
          {settings.canConfigure ? (
            <ApprovalSettingsFooter
              canSave={state.isDirty}
              isSaving={state.isSaving}
              error={state.saveError}
              onSave={state.save}
            />
          ) : null}
        </section>
      ) : null}
    </PageBody>
  )
}
