import { useMemo } from "react"
import { useNavigate, useParams } from "@tanstack/react-router"

import { ChangesBanner } from "~/components/dashboard/generation-changes/changes-banner"
import { ChangedPageSkeleton } from "~/components/dashboard/generation-changes/changed-page-skeleton"
import { ChangesSidebarPanel } from "~/components/dashboard/generation-changes/changes-sidebar-panel"
import { useSidebarPanel } from "~/lib/dashboard/sidebar-panel-context"

/**
 * The changes page while its code loads: the same strip, sidebar and page
 * shapes that the page draws while its data loads, so the visit has one
 * loading state.
 */
export function GenerationChangesPending() {
  const navigate = useNavigate()
  const { projectId = "", generationId = "" } = useParams({ strict: false })
  const sidebarPanel = useMemo(
    () => (
      <ChangesSidebarPanel
        pages={null}
        focusHref={null}
        onSelect={() => undefined}
        onBack={() =>
          void navigate({ to: "/dashboard/projects/$projectId/generations/$generationId", params: { projectId, generationId } })
        }
      />
    ),
    [generationId, navigate, projectId],
  )
  useSidebarPanel(sidebarPanel)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChangesBanner projectId={projectId} generationId={generationId} pullRequest={null} previewUrl={null} />
      <ChangedPageSkeleton />
    </div>
  )
}
