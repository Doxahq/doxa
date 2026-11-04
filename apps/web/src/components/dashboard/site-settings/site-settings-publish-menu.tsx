import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import { toast } from "sonner"

import { PublishMenu, type PublishMenuView } from "~/components/dashboard/content/branches/publish-menu"
import { SyncDialog } from "~/components/dashboard/content/branches/sync-dialog"
import { hostOf } from "~/components/dashboard/shell/site-settings-sidebar-view"
import { useProjectBranch } from "~/lib/dashboard/project-branch-context"
import { useBranchPreview } from "~/lib/dashboard/use-branch-preview"
import { useBranchStatus } from "~/lib/dashboard/use-branch-status"
import type { SiteSettingsState } from "~/lib/dashboard/use-site-settings"
import {
  projectContentMdxReportQueryOptions,
  projectContentQueryOptions,
  projectDetailQueryOptions,
} from "~/lib/queries/dashboard"
import { generationReviewQueryOptions } from "~/lib/queries/generation-review"

const NO_MDX_ISSUE_PAGES: readonly never[] = []

/**
 * The publish menu of the editor, on the site settings pages. It publishes the
 * whole branch, the same as the editor. The menu saves the settings as it opens.
 * If the settings cannot save, the menu stays closed, because a publish would
 * leave out the latest edits.
 */
export function SiteSettingsPublishMenu({
  projectId,
  overview,
  state,
}: {
  projectId: string
  overview: DocsContentOverviewDto
  state: SiteSettingsState
}) {
  const navigate = useNavigate()
  const branches = useProjectBranch()
  const branch = branches.branchRef
  const statusData = useBranchStatus(projectId, branch).data ?? null
  const isOverviewRefreshing = useQuery(projectContentQueryOptions(projectId, branch)).isFetching
  const mdxReport = useQuery(projectContentMdxReportQueryOptions(projectId, branch))
  const project = useQuery(projectDetailQueryOptions(projectId)).data?.project
  const review = useQuery(generationReviewQueryOptions(projectId))
  const preview = useBranchPreview({ projectId, branch, status: statusData, saveBuffer: state.saveNow })
  const [menu, setMenu] = useState<{ open: boolean; view: PublishMenuView }>({ open: false, view: "review" })
  const [isSyncOpen, setIsSyncOpen] = useState(false)

  // A review branch goes live through its review, which applies the page decisions.
  const isReviewBranch = branch !== "main" && (!review.isSuccess || review.data?.branch?.id === branch)
  if (isReviewBranch) return null

  const docsUrl = project?.publishedVersionId ? project.docsUrl : null
  const host = hostOf(docsUrl) ?? overview.projectSlug ?? "your site"

  function closeMenu() {
    setMenu((current) => ({ ...current, open: false }))
  }

  function changeOpen(open: boolean) {
    if (!open) {
      closeMenu()
      return
    }
    // The save attempt shows the errors on the page.
    if (state.errorCount > 0) {
      void state.saveNow()
      return
    }
    setMenu({ open: true, view: "review" })
    void state.saveNow().then((saved) => {
      if (saved) return
      closeMenu()
      toast.error("The settings could not be saved. Nothing was published.")
    })
  }

  async function openSynchronization() {
    if (!(await state.saveNow())) return
    closeMenu()
    // The dialog opens after the menu returns its focus.
    requestAnimationFrame(() => setIsSyncOpen(true))
  }

  return (
    <>
      <PublishMenu
        projectId={projectId}
        state={{
          overview,
          pages: overview.pages,
          hasChanges: state.isDirty || overview.working.changeCount > 0,
          isDirty: state.isDirty,
          isSaving: state.isSaving,
          isDiscarding: false,
          isOverviewRefreshing,
          mdxIssuePages: mdxReport.data?.pages ?? NO_MDX_ISSUE_PAGES,
          // Pages open in the editor. The route blocker saves the settings first.
          selectPage: async (href) => {
            await navigate({
              to: "/dashboard/projects/$projectId/content",
              params: { projectId },
              search: { page: href },
            })
          },
        }}
        branch={branch}
        namedBranch={branches.selectedBranch}
        branchName={branches.selectedBranch?.name ?? "main"}
        status={statusData}
        changeCount={statusData?.changeCount ?? overview.working.changeCount}
        host={host}
        docsUrl={docsUrl}
        preview={preview}
        open={menu.open}
        view={menu.view}
        onOpenChange={changeOpen}
        onViewChange={(view) => setMenu((current) => ({ ...current, view }))}
        onSynchronize={() => void openSynchronization()}
        // The site settings area opens again on main, without this menu, so a toast confirms the publish.
        onBranchErased={() => {
          toast.success(`Published to ${host}`)
          branches.selectBranch("main")
        }}
        // Agent requests are reviewed in the editor, which can show their page diffs.
        onOpenPageDiff={() => undefined}
      />
      <SyncDialog
        projectId={projectId}
        branch={branch}
        pages={overview.pages}
        open={isSyncOpen}
        onOpenChange={setIsSyncOpen}
        onSynchronized={() => void state.reloadFromBranch()}
      />
    </>
  )
}
