import { useEffect, useRef, useState, type ReactNode } from "react"
import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"
import type {
  BranchRef,
  DocsBranchPageDiff,
  DocsBranchStatus,
  NamedDocsBranch,
} from "@doxahq/contracts/docs-branches"
import { ArrowLeft, Check, Copy, ExternalLink, Link2, Loader2, Upload } from "lucide-react"
import { toast } from "sonner"

import {
  ProgressSteps,
  type ProgressStepItem,
  type ProgressStepState,
} from "~/components/dashboard/content/branches/progress-steps"
import { Button } from "~/components/ui/button"
import { Checkbox } from "~/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover"
import { ApprovalPanel } from "~/components/dashboard/content/branches/approval-panel"
import { PublishWarmStatus } from "~/components/dashboard/content/branches/publish-warm-status"
import {
  ChangedPages,
  MdxBlockedPages,
  openPage,
  PanelHeader,
  pageTitle,
  plural,
} from "~/components/dashboard/content/branches/publish-menu-parts"
import type { useBranchPreview } from "~/lib/dashboard/use-branch-preview"
import type { useProjectContent } from "~/lib/dashboard/use-project-content"
import {
  PUBLISH_STEPS,
  usePublishBranch,
  type PublishPhase,
  type PublishStep,
} from "~/lib/dashboard/use-publish-branch"
import { requesterLabel } from "~/lib/dashboard/approval-request-model"
import { cn } from "~/lib/utils"

type ContentState = ReturnType<typeof useProjectContent>
type BranchPreview = ReturnType<typeof useBranchPreview>
type PublishState = ReturnType<typeof usePublishBranch>

/**
 * review: what goes live. preview: the branch preview URL and its build.
 * approval: an agent's publish request, approved instead of published.
 */
export type PublishMenuView = "review" | "preview" | "approval"

export interface PublishMenuProps {
  projectId: string
  state: ContentState
  branch: BranchRef
  namedBranch: NamedDocsBranch | null
  branchName: string
  status: DocsBranchStatus | null
  /** Unpublished changes on the branch: pages, structure and site settings. */
  changeCount: number
  /** The host of the live site, for the copy. */
  host: string
  docsUrl: string | null
  preview: BranchPreview
  open: boolean
  view: PublishMenuView
  onOpenChange: (open: boolean) => void
  onViewChange: (view: PublishMenuView) => void
  onSynchronize: () => void
  onBranchErased: () => void
  /** A pending agent request to publish this branch, if any. */
  approvalRequest?: DashboardApprovalRequest | null
  /** Opens a changed page of the request in the editor's diff view. */
  onOpenPageDiff: (page: DocsBranchPageDiff) => void
}

const PUBLISH_STEP_TEXT: Record<PublishStep, { label: string; detail: string }> = {
  preparing: { label: "Preparing", detail: "Checks the branch and its changes" },
  building: { label: "Building", detail: "Writes the pages, navigation and search" },
  optimizing: { label: "Optimizing", detail: "Switches the site and clears its cache" },
  live: { label: "Live", detail: "Serves your changes" },
}

/**
 * The Publish button and its menu. Publish starts at once, with no second
 * confirmation, and the menu shows each stage until the changes are live.
 * The menu cannot close while a publish runs.
 */
export function PublishMenu(props: PublishMenuProps) {
  const { state, preview } = props
  const [eraseBranch, setEraseBranch] = useState(true)
  // Back from the preview returns to the panel that opened it.
  const [previewFrom, setPreviewFrom] = useState<PublishMenuView>("review")
  const publish = usePublishBranch({
    projectId: props.projectId,
    branch: props.branch,
    onPublished: (result) => {
      if (result.branchErased) props.onBranchErased()
    },
  })
  const locked = publish.phase === "publishing"
  const showsApproval = publish.phase === "idle" && props.view === "approval" && Boolean(props.approvalRequest)
  const behind = props.status?.behind ?? (state.overview ? !state.overview.working.isBaseCurrent : false)

  function changeOpen(open: boolean) {
    if (!open && locked) return
    props.onOpenChange(open)
  }

  function startPublish() {
    const working = state.overview?.working
    if (!working) return
    void publish.publish({
      expectedBaseVersionId: working.baseVersionId,
      expectedRevision: working.revision,
      eraseBranch: props.namedBranch ? eraseBranch : true,
    })
  }

  function showPreview() {
    setPreviewFrom(props.view === "approval" ? "approval" : "review")
    props.onViewChange("preview")
    if (!preview.isReady && !preview.isBuilding) void preview.build()
  }

  // The panel resets after the close animation, so the closing menu keeps its content.
  function resetAfterClose() {
    publish.reset()
    preview.reset()
    setEraseBranch(true)
    setPreviewFrom("review")
  }

  return (
    // While a publish runs, the menu is modal: the editor cannot change the
    // branch that goes live, and no click outside closes the menu.
    <Popover open={props.open} onOpenChange={changeOpen} modal={locked}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" disabled={!state.hasChanges || state.isDiscarding} className="gap-2">
          <Upload aria-hidden="true" />
          Publish
          {props.changeCount > 0 ? (
            <span className="bg-background px-1.5 py-px font-mono text-[10px] font-semibold text-foreground">
              {props.changeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        className={cn(
          "max-w-[calc(100vw-2rem)] p-0",
          showsApproval ? "w-[560px]" : "w-[440px]",
        )}
        onEscapeKeyDown={(event) => locked && event.preventDefault()}
        onInteractOutside={(event) => locked && event.preventDefault()}
        // Menus that open this one return focus to their own trigger.
        onFocusOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          // The content also remounts when the menu becomes modal.
          if (props.open) {
            event.preventDefault()
            return
          }
          resetAfterClose()
        }}
      >
        {publish.phase !== "idle" ? (
          <PublishProgressPanel
            {...props}
            publish={publish}
            onBack={publish.reset}
            onRetry={startPublish}
            onClose={() => changeOpen(false)}
          />
        ) : showsApproval && props.approvalRequest ? (
          <ApprovalPanel
            {...props}
            request={props.approvalRequest}
            onPreview={showPreview}
            onBack={() => props.onViewChange("review")}
          />
        ) : props.view === "preview" ? (
          <PreviewPanel {...props} onBack={() => props.onViewChange(previewFrom)} />
        ) : (
          <ReviewPanel
            {...props}
            behind={behind}
            eraseBranch={eraseBranch}
            onEraseBranchChange={setEraseBranch}
            onPublish={startPublish}
            onPreview={showPreview}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function ReviewPanel(props: PublishMenuProps & {
  behind: boolean
  eraseBranch: boolean
  onEraseBranchChange: (erase: boolean) => void
  onPublish: () => void
  onPreview: () => void
}) {
  const { state } = props
  // The menu saves the editor buffer when it opens. Publish waits for that
  // save, so the revision it sends is the one this list shows.
  const isSaving = state.isDirty || state.isSaving
  const hasMdxIssues = state.mdxIssuePages.length > 0
  const canPublish = (state.overview?.working.changeCount ?? 0) > 0 &&
    !isSaving &&
    !state.isOverviewRefreshing &&
    !hasMdxIssues

  return (
    <>
      <PanelHeader
        title={`Publish to ${props.host}`}
        description={`${plural(props.changeCount, "unpublished change")} on ${props.branchName}`}
      />
      {props.behind ? (
        <div className="mx-4 mt-3 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5 text-[13px] text-warning">
          Main changed after this branch started. Synchronize before you publish.
        </div>
      ) : null}
      {props.approvalRequest?.status === "pending" ? (
        <button
          type="button"
          onClick={() => props.onViewChange("approval")}
          className="mx-4 mt-3 rounded-md border border-primary/40 bg-primary-wash px-3 py-2.5 text-left text-[13px] text-primary-text hover:border-primary/70"
        >
          {requesterLabel(props.approvalRequest.requestedBy)} asked to publish this branch. Review the request.
        </button>
      ) : null}
      <MdxBlockedPages
        pages={state.mdxIssuePages}
        titleOf={(href) => pageTitle(state, href)}
        onOpenPage={(href) => openPage(props, href)}
      />
      <ChangedPages state={state} changeCount={props.changeCount} />
      {props.namedBranch && !props.behind ? (
        <label className="flex cursor-pointer items-center gap-2.5 border-t border-divider px-5 py-3 text-[13px] text-body">
          <Checkbox
            checked={props.eraseBranch}
            onChange={(event) => props.onEraseBranchChange(event.target.checked)}
          />
          Erase this branch after publish
        </label>
      ) : null}
      <PanelFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!props.preview.canBuild}
          title="Build a shareable preview of this branch"
          onClick={props.onPreview}
        >
          <Link2 aria-hidden="true" />
          Preview URL
        </Button>
        {props.behind ? (
          <Button type="button" size="sm" onClick={props.onSynchronize}>
            Synchronize first
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={!canPublish} onClick={props.onPublish}>
            {isSaving ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Upload aria-hidden="true" />}
            {isSaving ? "Saving…" : "Publish"}
          </Button>
        )}
      </PanelFooter>
    </>
  )
}

function PublishProgressPanel(props: PublishMenuProps & {
  publish: PublishState
  onBack: () => void
  onRetry: () => void
  onClose: () => void
}) {
  const { publish } = props
  const steps: ProgressStepItem[] = PUBLISH_STEPS.map((step, index) => ({
    label: PUBLISH_STEP_TEXT[step].label,
    detail: PUBLISH_STEP_TEXT[step].detail,
    state: publishStepState(publish.phase, PUBLISH_STEPS.indexOf(publish.step), index),
  }))
  const title = publish.phase === "live"
    ? `Published to ${props.host}`
    : publish.phase === "failed"
      ? "Publish failed"
      : `Publishing to ${props.host}`
  const description = publish.phase === "live"
    ? `Your changes from ${props.branchName} are live.`
    : publish.phase === "failed"
      ? "The live site did not change."
      : `Your changes from ${props.branchName} go live in a few seconds.`

  return (
    <>
      <PanelHeader title={title} description={description} />
      <div className="px-5 py-4">
        <ProgressSteps label="Publish progress" steps={steps} />
        {publish.phase === "failed" ? <PublishErrors publish={publish} /> : null}
        {publish.phase === "live" ? <PublishWarmStatus projectId={props.projectId} docsUrl={props.docsUrl} /> : null}
      </div>
      <PanelFooter>
        {publish.phase === "publishing" ? (
          <>
            <span />
            <Button type="button" size="sm" disabled>
              <Loader2 aria-hidden="true" className="animate-spin" />
              Publishing…
            </Button>
          </>
        ) : publish.phase === "live" ? (
          <>
            {props.docsUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={props.docsUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" />
                  Open site
                </a>
              </Button>
            ) : <span />}
            <Button type="button" size="sm" onClick={props.onClose}>Done</Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" onClick={props.onBack}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Button>
            {publish.errorCode === "branch_behind" ? (
              <Button type="button" size="sm" onClick={props.onSynchronize}>Synchronize first</Button>
            ) : publish.errorCode === "conflict" || publish.errorCode === "mdx_invalid" || publish.issues.length > 0 ? null : (
              <Button type="button" size="sm" onClick={props.onRetry}>Try again</Button>
            )}
          </>
        )}
      </PanelFooter>
    </>
  )
}

function PublishErrors({ publish }: { publish: PublishState }) {
  if (publish.issues.length > 0) {
    return (
      <ul role="alert" className="mt-4 space-y-1 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
        {publish.issues.map((issue, index) => (
          <li key={`${issue.path}:${issue.code}:${index}`}>{issue.message}</li>
        ))}
      </ul>
    )
  }
  return publish.error ? (
    <p role="alert" className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
      {publish.error}
    </p>
  ) : null
}

function PreviewPanel(props: PublishMenuProps & { onBack: () => void }) {
  const { preview } = props
  const firstState: ProgressStepState = preview.isBuilding
    ? "current"
    : preview.isReady
      ? "done"
      : preview.error
        ? "failed"
        : "pending"
  const steps: ProgressStepItem[] = [
    { label: "Preparing preview", detail: `Builds ${props.branchName} on its own URL`, state: firstState },
    {
      label: "Preview ready",
      detail: "Open it in a new tab or share the link",
      state: preview.isReady ? "done" : "pending",
    },
  ]

  return (
    <>
      <PanelHeader
        title="Preview URL"
        description={`A shareable URL with the changes on ${props.branchName}. Anyone with the link can open it.`}
      />
      <div className="px-5 py-4">
        <ProgressSteps label="Preview progress" steps={steps} />
        {preview.isReady && preview.url ? (
          <div className="mt-4 flex items-center overflow-hidden rounded-md border border-border bg-background">
            <span className="min-w-0 flex-1 truncate px-3 py-2 font-mono text-xs text-body" title={preview.url}>
              {preview.url.replace(/^https?:\/\//, "")}
            </span>
            <CopyLinkButton url={preview.url} />
          </div>
        ) : null}
        {preview.error && !preview.isBuilding ? (
          <p role="alert" className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            {preview.error}
          </p>
        ) : null}
      </div>
      <PanelFooter>
        <Button type="button" variant="outline" size="sm" onClick={props.onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
        {preview.isReady && preview.url ? (
          <Button asChild size="sm">
            <a href={preview.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              Open preview
            </a>
          </Button>
        ) : preview.isBuilding ? (
          <Button type="button" size="sm" disabled>
            <Loader2 aria-hidden="true" className="animate-spin" />
            Preparing…
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={!preview.canBuild} onClick={() => void preview.build()}>
            {preview.error ? "Try again" : "Build preview"}
          </Button>
        )}
      </PanelFooter>
    </>
  )
}

function PanelFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-divider px-5 py-3.5">{children}</div>
  )
}

function publishStepState(phase: PublishPhase, current: number, index: number): ProgressStepState {
  if (phase === "live" || index < current) return "done"
  if (index > current) return "pending"
  return phase === "failed" ? "failed" : "current"
}

const COPIED_FEEDBACK_MS = 1500

/**
 * Copies the link. A check replaces the copy icon for a moment, so the
 * button itself confirms the copy. Only a failure shows a toast.
 */
function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      toast.error("The link could not be copied.")
      return
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }

  return (
    <>
      <button
        type="button"
        aria-label={copied ? "Preview link copied" : "Copy preview link"}
        title={copied ? "Copied" : "Copy link"}
        onClick={() => void copy()}
        className="flex size-9 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground [&_svg]:size-3.5"
      >
        {copied ? <Check aria-hidden="true" strokeWidth={3} className="text-success" /> : <Copy aria-hidden="true" />}
      </button>
      <span role="status" className="sr-only">{copied ? "Preview link copied" : ""}</span>
    </>
  )
}
