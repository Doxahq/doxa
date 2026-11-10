import { useEffect, useMemo, type ComponentType, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import type {
  BranchRef,
  DocsBranchPageDiff,
  DocsBranchStatus,
  NamedDocsBranch,
} from "@doxahq/contracts/docs-branches"
import {
  Columns2,
  Copy,
  ExternalLink,
  GitCompareArrows,
  House,
  Link2,
  PenLine,
  RotateCcw,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"
import { AgentLockTag } from "~/components/dashboard/content/agent-lock-mark"
import { PublishMenu, type PublishMenuView } from "~/components/dashboard/content/branches/publish-menu"
import {
  MoreMenu,
  MoreMenuLabel,
  SiteMenuItems,
  TopBar,
} from "~/components/dashboard/shell/top-bar"
import { DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/dropdown-menu"
import { contentHomeHref, findPagePath, type ContentTreeSection } from "~/lib/dashboard/content-navigation"
import { isEditableTarget, useShell } from "~/lib/dashboard/shell-context"
import type { useBranchPreview } from "~/lib/dashboard/use-branch-preview"
import type { ProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import type { ContentViewMode, useProjectContent } from "~/lib/dashboard/use-project-content"
import { usePageLocks } from "~/lib/dashboard/use-page-locks"
import { projectDetailQueryOptions } from "~/lib/queries/dashboard"
import { cn } from "~/lib/utils"

type ContentState = ReturnType<typeof useProjectContent>
type BranchPreview = ReturnType<typeof useBranchPreview>

interface ModeOption {
  mode: ContentViewMode
  label: string
  icon: ComponentType<{ className?: string }>
  key: string
}

const MODES: ModeOption[] = [
  { mode: "write", label: "Write", icon: PenLine, key: "1" },
  { mode: "split", label: "Split", icon: Columns2, key: "2" },
]

/** Review mode adds the Diff view after Write and Split. */
const REVIEW_MODES: ModeOption[] = [...MODES, { mode: "diff", label: "Diff", icon: GitCompareArrows, key: "3" }]

/** What the top bar shows in review mode. */
export interface EditorTopBarReview {
  /** The page in the breadcrumb, which can be a page that the branch does not have. */
  href: string | null
  title: string | undefined
  /** Publish and Discard of the review, in place of the publish menu. */
  actions: ReactNode
}

interface EditorTopBarProps {
  projectId: string
  /** Hides Publish and the write actions that the viewer's role cannot do. */
  capabilities: ProjectCapabilities
  state: ContentState
  tree: readonly ContentTreeSection[]
  branch: BranchRef
  namedBranch: NamedDocsBranch | null
  branchName: string
  status: DocsBranchStatus | null
  /** Unpublished changes on the branch: pages, structure and site settings. */
  changeCount: number
  preview: BranchPreview
  publishMenu: { open: boolean; view: PublishMenuView }
  approvalRequest: DashboardApprovalRequest | null
  onPublishMenuOpenChange: (open: boolean) => void
  onPublishMenuViewChange: (view: PublishMenuView) => void
  onOpenPreview: () => void
  onSynchronize: () => void
  onBranchErased: () => void
  onOpenDiscard: () => void
  onOpenPageDiff: (page: DocsBranchPageDiff) => void
  /** Set in review mode. */
  review: EditorTopBarReview | null
  /** Null while the live agent activity is off for this project. */
  agentActivityButton: ReactNode
}

/** The top bar of the content editor. */
export function EditorTopBar(props: EditorTopBarProps) {
  const { state, tree, capabilities } = props
  const canWrite = capabilities.can("docs.write")
  const { toggleFocusMode } = useShell()
  const detail = useQuery(projectDetailQueryOptions(props.projectId))
  const docsUrl = detail.data?.project.publishedVersionId ? detail.data.project.docsUrl : null
  const siteConfig = state.overview?.siteConfig
  const homeHref = useMemo(
    () => contentHomeHref(state.pages, state.navigation, siteConfig),
    [siteConfig, state.navigation, state.pages],
  )
  const isHomePage = state.selectedHref !== null && state.selectedHref === homeHref
  const locks = usePageLocks(props.projectId)
  // A lock only matters to a project that generates its docs.
  const generates = Boolean(detail.data?.project.githubRepositoryId)
  const isLocked = generates && state.selectedHref !== null && locks.isLocked(state.selectedHref)
  const { review } = props
  const modes = review ? REVIEW_MODES : MODES

  // ⌘/Ctrl+1–3 switch the mode, ⌘/Ctrl+. toggles focus mode.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const mode = modes.find(({ key }) => key === event.key)
      if (mode) {
        event.preventDefault()
        state.setViewMode(mode.mode)
      } else if (event.key === "." && !isEditableTarget(event.target)) {
        event.preventDefault()
        toggleFocusMode()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [modes, state, toggleFocusMode])

  return (
    <TopBar
      crumbs={review ? pageCrumbs(tree, review.href, review.title) : pageCrumbs(tree, state.selectedHref, state.page?.title)}
      status={
        <span className="flex items-center gap-2.5">
          {review ? <ReviewTag /> : null}
          {isHomePage ? <DefaultPageTag /> : null}
          {isLocked ? <AgentLockTag className="max-[820px]:hidden" /> : null}
          <SaveState isSaving={state.isSaving} isDirty={state.isDirty} />
        </span>
      }
      actions={
        <>
          {review ? null : props.agentActivityButton}
          <ModeSwitch modes={modes} mode={state.viewMode} onChange={state.setViewMode} />
          {review ? review.actions : capabilities.can("docs.publish") ? (
            <PublishMenu
              projectId={props.projectId}
              state={state}
              branch={props.branch}
              namedBranch={props.namedBranch}
              branchName={props.branchName}
              status={props.status}
              changeCount={props.changeCount}
              host={hostOf(docsUrl) ?? state.overview?.projectSlug ?? "your site"}
              docsUrl={docsUrl}
              preview={props.preview}
              open={props.publishMenu.open}
              view={props.publishMenu.view}
              onOpenChange={props.onPublishMenuOpenChange}
              onViewChange={props.onPublishMenuViewChange}
              onSynchronize={props.onSynchronize}
              onBranchErased={props.onBranchErased}
              approvalRequest={props.approvalRequest}
              onOpenPageDiff={props.onOpenPageDiff}
            />
          ) : null}
        </>
      }
      menu={
        <MoreMenu>
          <MoreMenuLabel>This page</MoreMenuLabel>
          <DropdownMenuItem
            disabled={!docsUrl || !state.selectedHref}
            onSelect={() => {
              if (docsUrl && state.selectedHref) window.open(pageUrl(docsUrl, state.selectedHref), "_blank", "noopener,noreferrer")
            }}
          >
            <ExternalLink aria-hidden="true" />
            Open page on live site
          </DropdownMenuItem>
          {canWrite ? (
            <DropdownMenuItem disabled={!props.preview.canBuild} onSelect={props.onOpenPreview}>
              <Link2 aria-hidden="true" />
              Preview URL
            </DropdownMenuItem>
          ) : null}
          {props.preview.url ? (
            <DropdownMenuItem onSelect={() => void copyText(props.preview.url ?? "", "Preview link copied")}>
              <Copy aria-hidden="true" />
              Copy preview link
            </DropdownMenuItem>
          ) : null}
          {canWrite ? (
            <DropdownMenuItem
              disabled={state.page?.status !== "edited" || state.isSaving}
              onSelect={() => void state.resetPage()}
            >
              <RotateCcw aria-hidden="true" />
              Revert page to published
            </DropdownMenuItem>
          ) : null}
          {canWrite && capabilities.can("site.write") ? (
            <DropdownMenuItem
              disabled={!state.selectedHref || isHomePage}
              onSelect={() => {
                if (state.selectedHref) void state.structure.setHomePage(state.selectedHref).catch(() => undefined)
              }}
            >
              <House aria-hidden="true" />
              {isHomePage ? "Default page" : "Set as default page"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator className="my-1.5 bg-divider" />
          <SiteMenuItems projectId={props.projectId} />
          {canWrite && !review ? (
            <>
              <DropdownMenuSeparator className="my-1.5 bg-divider" />
              <DropdownMenuItem
                disabled={!state.hasChanges || state.isDiscarding}
                onSelect={props.onOpenDiscard}
                className="text-danger focus:text-danger [&_svg]:text-danger"
              >
                <Trash2 aria-hidden="true" />
                Discard all changes on {props.branchName}
              </DropdownMenuItem>
            </>
          ) : null}
        </MoreMenu>
      }
    />
  )
}

/** Says that the editor shows a generation review. */
function ReviewTag() {
  return (
    <span
      title="You are reviewing a generation. Your live site does not change until you publish."
      className="inline-flex shrink-0 items-center rounded-sm border border-primary/40 bg-primary-wash px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-[0.12em] text-primary-text uppercase max-[820px]:hidden"
    >
      Review
    </span>
  )
}

/** Marks the page that the site root shows. */
function DefaultPageTag() {
  return (
    <span
      title="The site root shows this page"
      className="inline-flex shrink-0 items-center rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-[0.12em] text-muted-foreground uppercase max-[820px]:hidden"
    >
      Default page
    </span>
  )
}

/** "Saving…" while a save runs, "Unsaved" while the buffer waits, "● Saved" once it is stored. */
function SaveState({ isSaving, isDirty }: { isSaving: boolean; isDirty: boolean }) {
  const saved = !isSaving && !isDirty
  return (
    <span
      role="status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] leading-none font-medium tracking-[0.12em] uppercase max-[820px]:hidden",
        saved ? "text-success" : "text-muted-foreground",
      )}
    >
      {saved ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {isSaving ? "Saving…" : isDirty ? "Unsaved" : "Saved"}
    </span>
  )
}

/** Write | Split (| Diff in review mode), as one segmented strip. */
function ModeSwitch({
  modes,
  mode,
  onChange,
}: {
  modes: readonly ModeOption[]
  mode: ContentViewMode
  onChange: (mode: ContentViewMode) => void
}) {
  return (
    <div role="group" aria-label="Editor mode" className="inline-flex overflow-hidden rounded-md border border-border bg-card">
      {modes.map(({ mode: value, label, icon: Icon, key }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={mode === value}
          aria-label={label}
          title={`${label} (⌘${key})`}
          className={cn(
            "flex items-center gap-1.5 border-r border-border px-2.5 py-[7px] font-mono text-[10.5px] font-medium tracking-[0.12em] uppercase transition-colors last:border-r-0 [&_svg]:size-3.5",
            mode === value
              ? "bg-primary-wash text-primary-text"
              : "text-muted-foreground hover:bg-overlay hover:text-foreground",
          )}
        >
          <Icon aria-hidden="true" />
          <span className="max-[980px]:hidden">{label}</span>
        </button>
      ))}
    </div>
  )
}

/** Section / group / page title for the breadcrumb. */
function pageCrumbs(
  tree: readonly ContentTreeSection[],
  href: string | null,
  title: string | undefined,
): string[] {
  const path = findPagePath(tree, href)
  const section = tree.find(({ slug }) => slug === path?.sectionSlug)
  const group = section?.groups.find(({ id }) => id === path?.groupId)
  return [section?.label, group?.heading ?? undefined, title ?? href ?? "Content"].filter(
    (crumb): crumb is string => Boolean(crumb),
  )
}

export function pageUrl(docsUrl: string, href: string): string {
  return `${docsUrl.replace(/\/$/, "")}${href === "/" ? "/" : href}`
}

export function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

async function copyText(text: string, message: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(message)
  } catch {
    toast.error("The link could not be copied.")
  }
}
