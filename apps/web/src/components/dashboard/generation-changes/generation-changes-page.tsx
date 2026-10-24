import { useMemo } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"
import { AlertCircle, FileCheck2 } from "lucide-react"

import { hostOf } from "~/components/dashboard/content/editor-top-bar"
import { ReviewReadOnlyBar } from "~/components/dashboard/content/review/review-decision-bar"
import { ReviewPageDiff } from "~/components/dashboard/content/review/review-diff-pane"
import { ReviewPageEvidence } from "~/components/dashboard/content/review/review-page-evidence"
import { EmptyState } from "~/components/dashboard/dashboard-header"
import { ChangesBanner } from "~/components/dashboard/generation-changes/changes-banner"
import { ChangedPageSkeleton } from "~/components/dashboard/generation-changes/changed-page-skeleton"
import { ChangesSidebarPanel } from "~/components/dashboard/generation-changes/changes-sidebar-panel"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { getErrorMessage } from "~/lib/errors"
import { CHANGED_PAGE_SENTENCE } from "~/lib/dashboard/generation-changes-model"
import { useSidebarPanel } from "~/lib/dashboard/sidebar-panel-context"
import { siteCanvasTheme, useCanvasMode, type CanvasSettings } from "~/lib/dashboard/site-canvas"
import { useGenerationChanges, type ChangesSteps } from "~/lib/dashboard/use-generation-changes"
import { useLiveDocsUrl } from "~/lib/dashboard/use-live-docs-url"
import { projectContentQueryOptions, projectGenerationQueryOptions } from "~/lib/queries/dashboard"
import { generationChangedPageQueryOptions } from "~/lib/queries/generation-changes"

/**
 * The changes of a pull request preview run, read-only, in the layout of
 * the content review: the changed pages in the sidebar, and the open page
 * as a diff of its source beside the rendered page. Nobody decides here. A
 * merge starts a production run, and its review publishes the changes.
 */
export function GenerationChangesPage(props: {
  projectId: string
  generationId: string
  /** The page in the URL. */
  pageHref: string | null
  onPageShown: (href: string) => void
}) {
  const { projectId, generationId } = props
  const navigate = useNavigate()
  const changes = useGenerationChanges(props)
  const generation = useQuery(projectGenerationQueryOptions(projectId, generationId))
  const canvas = useSiteCanvas(projectId)
  const liveDocsUrl = useLiveDocsUrl(projectId)
  const previewUrl = changes.changes?.previewUrl ?? null

  const isLoaded = changes.query.isSuccess
  const sidebarPanel = useMemo(
    () => (
      <ChangesSidebarPanel
        pages={isLoaded ? changes.pages : null}
        focusHref={changes.focusHref}
        onSelect={props.onPageShown}
        onBack={() =>
          void navigate({ to: "/dashboard/projects/$projectId/generations/$generationId", params: { projectId, generationId } })
        }
      />
    ),
    [changes.focusHref, changes.pages, generationId, isLoaded, navigate, projectId, props.onPageShown],
  )
  useSidebarPanel(sidebarPanel)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChangesBanner
        projectId={projectId}
        generationId={generationId}
        pullRequest={generation.data?.source.changeProposal ?? null}
        previewUrl={previewUrl}
      />
      {changes.query.error ? (
        <div className="border-t border-border p-6">
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Could not load the changes</AlertTitle>
            <AlertDescription>{getErrorMessage(changes.query.error, "The changes could not be loaded.")}</AlertDescription>
          </Alert>
        </div>
      ) : !isLoaded ? (
        <ChangedPageSkeleton />
      ) : changes.focusedPage && changes.steps ? (
        <ChangedPage
          projectId={projectId}
          generationId={generationId}
          page={changes.focusedPage}
          steps={changes.steps}
          canvas={canvas}
          previewUrl={previewUrl}
          liveDocsUrl={liveDocsUrl}
          onStep={props.onPageShown}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center border-t border-border p-6">
          <EmptyState
            icon={<FileCheck2 />}
            title="No page changes"
            description="This pull request changes no documentation page."
          />
        </div>
      )}
    </div>
  )
}

/** One changed page: its bar, the evidence behind it, and the diff. */
function ChangedPage(props: {
  projectId: string
  generationId: string
  page: GenerationReviewPage
  steps: ChangesSteps
  canvas: CanvasSettings
  previewUrl: string | null
  liveDocsUrl: string | null
  onStep: (href: string) => void
}) {
  const sources = useQuery(generationChangedPageQueryOptions(props.projectId, props.generationId, props.page.href))

  return (
    <section aria-label={`Changes to ${props.page.title}`} className="flex min-h-0 flex-1 flex-col border-t border-border">
      <ReviewReadOnlyBar
        steps={props.steps}
        page={props.page}
        sentence={CHANGED_PAGE_SENTENCE[props.page.change]}
        onStep={props.onStep}
      />
      <ReviewPageEvidence page={props.page} />
      <ReviewPageDiff
        page={props.page}
        sources={sources.data ?? null}
        error={sources.error}
        canvas={props.canvas}
        host={hostOf(props.previewUrl) ?? ""}
        previewUrl={props.previewUrl}
        liveDocsUrl={props.liveDocsUrl}
      />
    </section>
  )
}

/** The theme of the live site, so the rendered page looks as it will publish. */
function useSiteCanvas(projectId: string): CanvasSettings {
  const content = useQuery(projectContentQueryOptions(projectId, "main"))
  const theme = useMemo(() => siteCanvasTheme(content.data?.siteConfig ?? null), [content.data?.siteConfig])
  const [mode, onModeChange] = useCanvasMode(theme)
  return useMemo(() => ({ theme, mode, onModeChange }), [mode, onModeChange, theme])
}
