import { lazy, Suspense, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type {
  GenerationChangedPage,
  GenerationReviewPage,
  GenerationReviewPageSources,
} from "@doxahq/contracts/generation-reviews"

import { PreviewSkeleton, SourceSkeleton } from "~/components/dashboard/content/editor-skeleton"
import { hostOf, pageUrl } from "~/components/dashboard/content/editor-top-bar"
import { PreviewFrame } from "~/components/dashboard/content/preview-frame"
import {
  ReviewDecisionBar,
  type ReviewDecisionControl,
} from "~/components/dashboard/content/review/review-decision-bar"
import { ReviewPageEvidence } from "~/components/dashboard/content/review/review-page-evidence"
import { SiteCanvas } from "~/components/dashboard/content/site-canvas"
import { SegmentedControl } from "~/components/dashboard/content/site-settings/fields/controls"
import { getErrorMessage } from "~/lib/errors"
import { hasLightMode, type CanvasSettings } from "~/lib/dashboard/site-canvas"
import type { ContentReviewSession } from "~/lib/dashboard/use-content-review"
import { generationReviewPageQueryOptions } from "~/lib/queries/generation-review"

// CodeMirror and the MDX parser load only when a diff opens.
const MdxUnifiedDiffView = lazy(() => import("~/components/code-editor/mdx-unified-diff-view"))
const MdxMergeView = lazy(() => import("~/components/code-editor/mdx-merge-view"))
const MdxPreview = lazy(() => import("~/components/dashboard/content/mdx-preview"))

type DiffLayout = "unified" | "split"
type RenderedVersion = "generated" | "published"

/**
 * Review mode's Diff view of one page: the MDX change on the left, like a
 * pull request, and the rendered page on the right. Both sides compare the
 * live site with what the generation wrote, whatever the decision is.
 */
export function ReviewDiffPane(props: {
  projectId: string
  session: ContentReviewSession
  page: GenerationReviewPage
  decision: ReviewDecisionControl
  canvas: CanvasSettings
  /** The address that the preview shows before the page path. */
  host: string
  liveDocsUrl: string | null
  onStep: (href: string) => void
  /** Opens the summary that finishes the review. */
  onFinish: () => void
}) {
  const sources = useQuery(generationReviewPageQueryOptions(props.projectId, props.page.href))

  return (
    <section aria-label={`Changes to ${props.page.title}`} className="flex min-h-0 flex-1 flex-col border-t border-border">
      <ReviewDecisionBar
        session={props.session}
        page={props.page}
        decision={props.decision}
        onStep={props.onStep}
        onFinish={props.onFinish}
      />
      <ReviewPageEvidence page={props.page} />
      <ReviewPageDiff
        page={props.page}
        sources={sources.data ?? null}
        error={sources.error}
        canvas={props.canvas}
        host={props.host}
        previewUrl={props.session.review.previewUrl}
        liveDocsUrl={props.liveDocsUrl}
      />
    </section>
  )
}

/**
 * One changed page, like a pull request: the MDX change on the left and the
 * rendered page on the right. A review and the read-only changes of a pull
 * request preview both show it.
 */
export function ReviewPageDiff(props: {
  page: GenerationChangedPage
  /** Null while the sources load. */
  sources: GenerationReviewPageSources | null
  error: Error | null
  canvas: CanvasSettings
  /** The address that the preview shows before the page path. */
  host: string
  /** The site that the run wrote. */
  previewUrl: string | null
  liveDocsUrl: string | null
}) {
  if (props.error) {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-destructive">
        {getErrorMessage(props.error, "The diff could not be loaded.")}
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-row max-[820px]:flex-col">
      <SourceDiff page={props.page} sources={props.sources} />
      <RenderedPage
        // A new page starts on its own version of the render.
        key={props.page.href}
        page={props.page}
        sources={props.sources}
        canvas={props.canvas}
        host={props.host}
        previewUrl={props.previewUrl}
        liveDocsUrl={props.liveDocsUrl}
      />
    </div>
  )
}

/** The MDX change in one column, or the two versions side by side. */
function SourceDiff(props: { page: GenerationChangedPage; sources: GenerationReviewPageSources | null }) {
  const [layout, setLayout] = useState<DiffLayout>("unified")
  const before = props.sources?.published ?? ""
  const after = props.sources?.generated ?? ""
  // A new or a removed page has only one side, so side by side shows nothing more.
  const canSplit = props.page.change === "modified"
  const shown = canSplit ? layout : "unified"

  return (
    <section
      aria-label="Source changes"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-border bg-card max-[820px]:border-r-0 max-[820px]:border-b"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-divider px-4 py-1.5">
        <span className="font-mono text-[10.5px] tracking-[0.1em] text-label uppercase">
          {shown === "split" ? "Live site | Generated" : "MDX changes"}
        </span>
        {canSplit ? (
          <SegmentedControl
            label="Diff layout"
            value={layout}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Side by side" },
            ]}
            onValueChange={setLayout}
          />
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {props.sources === null ? (
          <SourceSkeleton />
        ) : (
          <Suspense fallback={<SourceSkeleton />}>
            {shown === "split" ? (
              <MdxMergeView before={before} after={after} labels={{ before: "Live site source", after: "Generated source" }} />
            ) : (
              <MdxUnifiedDiffView before={before} after={after} label={`MDX changes of ${props.page.title}`} />
            )}
          </Suspense>
        )}
      </div>
    </section>
  )
}

/** The page as the site draws it, generated or live, in a browser frame. */
function RenderedPage(props: {
  page: GenerationChangedPage
  sources: GenerationReviewPageSources | null
  canvas: CanvasSettings
  host: string
  previewUrl: string | null
  liveDocsUrl: string | null
}) {
  const { change, href } = props.page
  const [version, setVersion] = useState<RenderedVersion>(change === "removed" ? "published" : "generated")
  const source = version === "generated" ? props.sources?.generated : props.sources?.published
  const isGenerated = version === "generated"
  const baseUrl = isGenerated ? props.previewUrl : props.liveDocsUrl

  return (
    <section aria-label="Rendered page" className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
      <PreviewFrame
        host={hostOf(baseUrl) ?? props.host}
        href={href}
        open={{
          url: baseUrl ? pageUrl(baseUrl, href) : null,
          label: isGenerated ? "Open the page in the generation preview" : "Open the live page",
          unavailableTitle: isGenerated ? "The generation preview is not available." : "The site is not published yet.",
        }}
        colorMode={hasLightMode(props.canvas.theme) ? { mode: props.canvas.mode, onChange: props.canvas.onModeChange } : null}
        controls={
          <SegmentedControl
            label="Page version"
            value={version}
            options={[
              { value: "generated", label: "Generated", disabled: change === "removed" },
              { value: "published", label: "Live", disabled: change === "added" },
            ]}
            onValueChange={setVersion}
          />
        }
      >
        {props.sources === null ? (
          <PreviewSkeleton />
        ) : (
          <Suspense fallback={<PreviewSkeleton />}>
            <SiteCanvas theme={props.canvas.theme} mode={props.canvas.mode} className="min-h-full">
              <MdxPreview source={source ?? ""} />
            </SiteCanvas>
          </Suspense>
        )}
      </PreviewFrame>
    </section>
  )
}
