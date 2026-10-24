import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { AlertCircle } from "lucide-react"
import { toast } from "sonner"
import type { DocsMdxIssue } from "@doxahq/contracts"
import type { BranchRef, DocsBranchPageDiff } from "@doxahq/contracts/docs-branches"
import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"

import { ContentPageList } from "~/components/dashboard/content/content-page-list"
import {
  BranchPageDiffPane,
  type PageDiffTarget,
} from "~/components/dashboard/content/branches/branch-page-diff-pane"
import { BranchStatusBanner } from "~/components/dashboard/content/branches/branch-status-banner"
import { BranchSwitcher } from "~/components/dashboard/content/branches/branch-switcher"
import { CreateBranchDialog } from "~/components/dashboard/content/branches/create-branch-dialog"
import { DiscardChangesDialog } from "~/components/dashboard/content/branches/discard-changes-dialog"
import { HistoryPanel } from "~/components/dashboard/content/branches/history-panel"
import type { PublishMenuView } from "~/components/dashboard/content/branches/publish-menu"
import { SyncDialog } from "~/components/dashboard/content/branches/sync-dialog"
import { EditorTopBar, hostOf, pageUrl } from "~/components/dashboard/content/editor-top-bar"
import type { SourceReveal } from "~/components/dashboard/content/mdx-code-editor"
import { PageMdxIssues } from "~/components/dashboard/content/page-mdx-issues"
import { PreviewFrame } from "~/components/dashboard/content/preview-frame"
import { ReviewActions } from "~/components/dashboard/content/review/review-actions"
import type { ReviewGroupDecisions } from "~/components/dashboard/content/review/review-group-actions"
import { ReviewBanner, ReviewWaitingNotice } from "~/components/dashboard/content/review/review-banner"
import { ReviewModeArea } from "~/components/dashboard/content/review/review-mode-area"
import { ReviewSidebarPanel } from "~/components/dashboard/content/review/review-sidebar-panel"
import { SiteCanvas } from "~/components/dashboard/content/site-canvas"
import type { PageIconEdit } from "~/components/dashboard/content/write-editor/page-icon-picker"
import type { PageSlugEdit } from "~/components/dashboard/content/write-editor/page-slug-field"
import { SidebarViewHeader } from "~/components/dashboard/shell/sidebar-view-stack"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { EditorSkeleton, PreviewSkeleton, SourceSkeleton } from "~/components/dashboard/content/editor-skeleton"
import { useSidebar } from "~/components/ui/sidebar"
import { buildContentTree, contentHomeHref, findPagePath, firstChangedHref, type ContentTreeSection } from "~/lib/dashboard/content-navigation"
import { sourceOffset } from "~/lib/dashboard/mdx-issues"
import { pageSlugTarget } from "~/lib/dashboard/page-slug"
import { getErrorMessage } from "~/lib/errors"
import { useProjectBranch } from "~/lib/dashboard/project-branch-context"
import { ReviewPageMarksProvider } from "~/lib/dashboard/review-page-marks-context"
import { isEditableTarget, useShell } from "~/lib/dashboard/shell-context"
import { useSidebarPanel } from "~/lib/dashboard/sidebar-panel-context"
import { useAgentPublishRequest } from "~/lib/dashboard/use-agent-publish-request"
import { useBranchPreview } from "~/lib/dashboard/use-branch-preview"
import { useBranchStatus } from "~/lib/dashboard/use-branch-status"
import { useContentReview } from "~/lib/dashboard/use-content-review"
import { useReviewDecisions } from "~/lib/dashboard/use-review-decisions"
import { useLiveDocsUrl } from "~/lib/dashboard/use-live-docs-url"
import { EditorAssetsProvider } from "~/lib/dashboard/editor-assets"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectContent } from "~/lib/dashboard/use-project-content"
import { loadDocsHighlighter } from "~/lib/editor/docs-highlighter"
import { hasLightMode, siteCanvasTheme, useCanvasMode, type CanvasSettings } from "~/lib/dashboard/site-canvas"

// CodeMirror and the MDX parser are the heavy modules on this screen. Loading
// them on demand keeps every other dashboard route unchanged in size.
const MdxCodeEditor = lazy(() => import("~/components/dashboard/content/mdx-code-editor"))
const MdxPreview = lazy(() => import("~/components/dashboard/content/mdx-preview"))
const NO_REVIEW_PAGES: readonly GenerationReviewPage[] = []
// TipTap and the MDX bridge stay out of the other dashboard routes, but Write
// is the default mode, so the download starts as soon as this screen's code
// runs, in parallel with the content requests. The page keeps its skeleton
// until both are ready. The component renders directly, not through `lazy`:
// a lazy component suspends once even when its code is there, and that
// would swap in a second skeleton for a frame.
const writeEditorModule = import("~/components/dashboard/content/write-editor/write-editor")
// The code highlighter (its themes and engine, no grammars) loads with the
// editor code, not after the page arrives. The editor's highlight plugin
// shares the same instance, which is then ready. The plugin also starts the
// load itself, and it handles a failure, so a failure is ignored here.
void loadDocsHighlighter().catch(() => undefined)

type WriteEditorComponent = (typeof import("~/components/dashboard/content/write-editor/write-editor"))["default"]

/** The Write editor once its code is loaded. A failed download throws to the error boundary. */
function useWriteEditor(): WriteEditorComponent | null {
  const [loaded, setLoaded] = useState<{ component: WriteEditorComponent } | { error: unknown } | null>(null)
  useEffect(() => {
    let live = true
    writeEditorModule.then(
      (module) => live && setLoaded({ component: module.default }),
      (error: unknown) => live && setLoaded({ error }),
    )
    return () => {
      live = false
    }
  }, [])
  if (loaded && "error" in loaded) throw loaded.error
  return loaded?.component ?? null
}

type ContentState = ReturnType<typeof useProjectContent>

/** Keeps the latest value in a ref, so a callback can read it and stay stable. */
function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

export function ProjectContentPage({
  projectId,
  approvalRequestId = null,
  onApprovalLinkOpened,
  pageHref = null,
  onPageShown,
  reviewRequested = false,
  onReviewEntryHandled = noop,
}: {
  projectId: string
  /** An agent publish request from the approval link, reviewed in the publish menu. */
  approvalRequestId?: string | null
  /** Removes the request from the URL once the menu shows it. */
  onApprovalLinkOpened?: () => void
  /** The page in the URL. The editor opens it first when it exists. */
  pageHref?: string | null
  /** Writes the open page to the URL. */
  onPageShown?: (href: string) => void
  /** True when the URL asks to open the generation review. */
  reviewRequested?: boolean
  /** Removes the review request from the URL once the review opens. */
  onReviewEntryHandled?: () => void
}) {
  const branches = useProjectBranch()
  const state = useProjectContent(projectId, branches.branchRef, { requestedHref: pageHref })
  // The URL follows the open page, so a reload opens it again.
  useEffect(() => {
    if (state.selectedHref && state.selectedHref !== pageHref) onPageShown?.(state.selectedHref)
  }, [onPageShown, pageHref, state.selectedHref])
  const capabilities = useProjectCapabilities(projectId)
  const canWrite = capabilities.can("docs.write")
  const canPublish = capabilities.can("docs.publish")
  const status = useBranchStatus(projectId, branches.branchRef)
  const mainStatus = useBranchStatus(projectId, "main", branches.branchRef !== "main")
  const mainStatusData = branches.branchRef === "main" ? status.data : mainStatus.data
  const preview = useBranchPreview({
    projectId,
    branch: branches.branchRef,
    status: status.data ?? null,
    saveBuffer: state.saveBuffer,
  })
  // CodeMirror needs a DOM. Rendering it after mount keeps the server render
  // and the first client render identical.
  const [isMounted, setIsMounted] = useState(false)
  useEffect(() => setIsMounted(true), [])
  const WriteEditor = useWriteEditor()
  const isWriteEditorReady = WriteEditor !== null
  // The page body is ready once its content, its code and the page itself are
  // there. Until then the body shows one skeleton, and the sidebar keeps its
  // own, so a reload swaps both to the real screen in the same frame. After
  // the first time, the sidebar list stays, also while another page loads.
  const isBodyReady =
    !state.isLoading &&
    (state.pages.length === 0 ||
      (state.selectedHref !== null &&
        !state.isPageLoading &&
        isMounted &&
        (state.viewMode !== "write" || isWriteEditorReady)))
  const wasBodyReadyRef = useRef(false)
  if (isBodyReady) wasBodyReadyRef.current = true
  const showSidebarList = state.overview !== null && wasBodyReadyRef.current

  const { pages, navigation, highlightedHref } = state
  const isBusy = state.isDiscarding
  const tree = useMemo(() => buildContentTree(pages, navigation), [navigation, pages])
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [createName, setCreateName] = useState("")
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [isSyncOpen, setIsSyncOpen] = useState(false)
  const [publishMenu, setPublishMenu] = useState<{ open: boolean; view: PublishMenuView }>({
    open: false,
    view: "review",
  })
  const [isDiscardOpen, setIsDiscardOpen] = useState(false)

  // The sidebar panel must not change per keystroke, so its callbacks read the
  // latest editor state through refs instead of closing over it.
  const stateRef = useLatest(state)
  const branchesRef = useLatest(branches)
  const shell = useShell()
  const sidebar = useSidebar()
  const sidebarRef = useLatest(sidebar)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const switchBranch = useCallback(async (branch: BranchRef) => {
    if (branch === branchesRef.current.branchRef) return
    if (!(await stateRef.current.saveBuffer())) return
    branchesRef.current.selectBranch(branch)
  }, [branchesRef, stateRef])

  // Review mode: the open generation review, while its branch is checked out.
  const review = useContentReview({
    projectId,
    branches,
    switchBranch,
    initialHref: pageHref,
    entryRequested: reviewRequested,
    onEntryHandled: onReviewEntryHandled,
    branchRevision: state.overview?.working.revision ?? null,
  })
  const session = review.session
  const reviewRef = useLatest(review)
  useReviewModeSync(state, session)

  // The decision bar and the sidebar groups share the decisions, with one Undo and one edits question.
  const decisions = useReviewDecisions(session?.pages ?? NO_REVIEW_PAGES, review.actions, review.focusOn)
  const decisionsRef = useLatest(decisions)
  const isDecisionBlocked =
    decisions.editsAtRisk !== null ||
    review.actions.isDeciding ||
    review.actions.isPublishing ||
    review.actions.isDiscarding
  const groupDecisions = useMemo<ReviewGroupDecisions>(
    () => ({
      onDecideAll: (pages, decision) => decisionsRef.current.decideAll(pages, decision),
      disabled: isDecisionBlocked,
    }),
    [decisionsRef, isDecisionBlocked],
  )

  // In a review, a page opens through the review's focus, which can also be
  // a page that the branch no longer has (see `useReviewModeSync`).
  const onSelect = useCallback((href: string) => {
    const current = reviewRef.current
    if (current.session) current.focusOn(href)
    else void stateRef.current.selectPage(href)
    if (sidebarRef.current.isMobile) sidebarRef.current.setOpenMobile(false)
  }, [reviewRef, sidebarRef, stateRef])

  const closeReview = useCallback(() => {
    stateRef.current.resetAfterExternalChange()
    branchesRef.current.selectBranch("main")
  }, [branchesRef, stateRef])

  const openCreateBranch = useCallback(async (name: string) => {
    if (!(await stateRef.current.saveBuffer())) return
    setCreateName(name)
    setIsCreateOpen(true)
  }, [stateRef])

  const openSynchronization = useCallback(async () => {
    if (!(await stateRef.current.saveBuffer())) return false
    setIsSyncOpen(true)
    return true
  }, [stateRef])

  // The publish menu lists the saved branch, so it saves the buffer as it
  // opens. Its Publish button waits for that save.
  const openPublish = useCallback(() => {
    setPublishMenu({ open: true, view: "review" })
    void stateRef.current.saveBuffer()
  }, [stateRef])

  const changePublishMenuOpen = useCallback((open: boolean) => {
    if (open) openPublish()
    else setPublishMenu((menu) => ({ ...menu, open: false }))
  }, [openPublish])

  const changePublishMenuView = useCallback((view: PublishMenuView) => {
    setPublishMenu((menu) => ({ ...menu, view }))
  }, [])

  // The approval link lands on the changes: once the branch content loads,
  // the editor opens the first changed page instead of the first page.
  const [showChangesOn, setShowChangesOn] = useState<BranchRef | null>(null)
  const openApproval = useCallback(() => {
    setPublishMenu({ open: true, view: "approval" })
    setShowChangesOn(branchesRef.current.branchRef)
    void stateRef.current.saveBuffer()
  }, [branchesRef, stateRef])
  useEffect(() => {
    if (showChangesOn === null) return
    if (showChangesOn !== branches.branchRef) {
      setShowChangesOn(null)
      return
    }
    if (!state.overview) return
    setShowChangesOn(null)
    const href = firstChangedHref(state.pages, state.navigation)
    if (href) void stateRef.current.selectPage(href)
  }, [branches.branchRef, showChangesOn, state.navigation, state.overview, state.pages, stateRef])
  const approvalRequest = useAgentPublishRequest({
    projectId,
    linkedRequestId: approvalRequestId,
    branchRef: branches.branchRef,
    selectBranch: branches.selectBranch,
    openApproval,
    onLinkOpened: onApprovalLinkOpened,
  })

  // The Diff button of the approve panel: the page opens in Split mode, and
  // the Split panes show its source against main until the diff closes.
  const [pageDiff, setPageDiff] = useState<{ branch: BranchRef; page: PageDiffTarget } | null>(null)
  const openPageDiff = useCallback((page: DocsBranchPageDiff) => {
    const current = stateRef.current
    setPublishMenu((menu) => ({ ...menu, open: false }))
    current.setViewMode("split")
    if (page.change !== "deleted") void current.selectPage(page.href)
    setPageDiff({
      branch: branchesRef.current.branchRef,
      page: { href: page.href, title: page.title, change: page.change },
    })
  }, [branchesRef, stateRef])
  const closePageDiff = useCallback(() => setPageDiff(null), [])
  const backToRequest = useCallback(() => {
    setPageDiff(null)
    setPublishMenu({ open: true, view: "approval" })
  }, [])
  const shownPageDiff = pageDiff?.branch === branches.branchRef ? pageDiff.page : null

  // The build saves the buffer first. An up-to-date preview opens as ready.
  const previewRef = useLatest(preview)
  const openPreview = useCallback(() => {
    const current = previewRef.current
    if (!current.isReady && !current.isBuilding) void current.build()
    setPublishMenu({ open: true, view: "preview" })
  }, [previewRef])

  const openSynchronizationFromPublish = useCallback(async () => {
    if (!(await state.saveBuffer())) return
    setPublishMenu((menu) => ({ ...menu, open: false }))
    requestAnimationFrame(() => setIsSyncOpen(true))
  }, [state])

  // "/" lands in the page search of the Content view.
  const { showView, view } = shell
  const [searchFocusRequest, setSearchFocusRequest] = useState(0)
  const focusPageSearch = useCallback(() => {
    showView("content")
    const current = sidebarRef.current
    if (current.isMobile) current.setOpenMobile(true)
    else if (!current.open) current.setOpen(true)
    setSearchFocusRequest((count) => count + 1)
  }, [showView, sidebarRef])

  // A hidden view is inert, so the search can take focus only after the
  // Content view has rendered as the current one. Effects run after that
  // commit, so no frame delay is needed.
  useEffect(() => {
    if (searchFocusRequest === 0 || view !== "content") return
    searchInputRef.current?.focus()
    setSearchFocusRequest(0)
  }, [searchFocusRequest, view])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target) || event.defaultPrevented) return
      event.preventDefault()
      focusPageSearch()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [focusPageSearch])

  const statusData = status.data ?? null
  const maxBranches = branches.maxBranchesPerSite
    ?? state.overview?.entitlements.maxBranchesPerSite
    ?? 10
  const siteConfig = state.overview?.siteConfig
  const homeHref = useMemo(
    () => contentHomeHref(pages, navigation, siteConfig),
    [navigation, pages, siteConfig],
  )
  const homePending = state.structure.pendingHomeHref !== null
  const home = useMemo(() => ({ href: homeHref, pending: homePending }), [homeHref, homePending])
  const sidebarPanel = useMemo(
    () => {
      const pageList = (
        <ContentPageList
          projectId={projectId}
          pages={pages}
          navigation={navigation}
          selectedHref={session ? session.focusHref : highlightedHref}
          home={home}
          onSelect={onSelect}
          disabled={isBusy}
          readOnly={!canWrite}
          structure={state.structure}
          searchInputRef={searchInputRef}
        />
      )
      return (
      <>
        <SidebarViewHeader label="Content" backLabel="Back to project" onBack={() => showView("project")}>
          <BranchSwitcher
            projectId={projectId}
            branch={branches.branchRef}
            branches={branches.branches}
            status={statusData}
            mainChangeCount={mainStatusData?.changeCount ?? 0}
            maxBranches={maxBranches}
            disabled={isBusy}
            canWrite={canWrite}
            canPublish={canPublish}
            onSelect={switchBranch}
            onCreate={(name) => void openCreateBranch(name)}
            onBranchErased={(branchId) => {
              if (branchId === branches.branchRef) branches.selectBranch("main")
            }}
            onHistory={() => setIsHistoryOpen(true)}
            onCompare={() => void openSynchronization()}
            onMerge={openPublish}
          />
        </SidebarViewHeader>
        {session ? (
          <ReviewSidebarPanel
            projectId={projectId}
            session={session}
            canWrite={canWrite}
            groupDecisions={groupDecisions}
            onSelect={onSelect}
            onFilterChange={review.setFilter}
            allPages={<ReviewPageMarksProvider pages={session.pages}>{pageList}</ReviewPageMarksProvider>}
          />
        ) : (
          pageList
        )}
      </>
      )
    },
    [
      branches.branchRef,
      branches.branches,
      canPublish,
      canWrite,
      groupDecisions,
      highlightedHref,
      home,
      isBusy,
      mainStatusData?.changeCount,
      maxBranches,
      navigation,
      onSelect,
      openCreateBranch,
      openPublish,
      openSynchronization,
      pages,
      projectId,
      review.setFilter,
      session,
      showView,
      state.structure,
      statusData,
      switchBranch,
    ],
  )
  useSidebarPanel(showSidebarList ? sidebarPanel : null)

  const branchName = branches.selectedBranch?.name ?? "main"

  // Write, the Split preview and the review's rendered page share one theme and Light/Dark mode.
  const theme = useMemo(() => siteCanvasTheme(siteConfig ?? null), [siteConfig])
  const [canvasMode, setCanvasMode] = useCanvasMode(theme)
  const canvas = useMemo<CanvasSettings>(
    () => ({ theme, mode: canvasMode, onModeChange: setCanvasMode }),
    [canvasMode, setCanvasMode, theme],
  )
  const liveDocsUrl = useLiveDocsUrl(projectId)
  const previewHost = hostOf(liveDocsUrl) ?? state.overview?.projectSlug ?? ""
  const editorPanes = (
    <EditorPanes
      state={state}
      tree={tree}
      isMounted={isMounted}
      WriteEditor={WriteEditor}
      readOnly={!canWrite}
      canvas={canvas}
      previewHost={previewHost}
      liveDocsUrl={liveDocsUrl}
    />
  )

  return (
    <EditorAssetsProvider projectId={projectId} branch={branches.branchRef}>
      <div className="flex min-h-0 flex-1 flex-col">
        <EditorTopBar
          projectId={projectId}
          capabilities={capabilities}
          state={state}
          tree={tree}
          branch={branches.branchRef}
          namedBranch={branches.selectedBranch}
          branchName={branchName}
          status={statusData}
          changeCount={statusData?.changeCount ?? state.overview?.working.changeCount ?? 0}
          preview={preview}
          publishMenu={publishMenu}
          approvalRequest={approvalRequest}
          onPublishMenuOpenChange={changePublishMenuOpen}
          onPublishMenuViewChange={changePublishMenuView}
          onOpenPreview={openPreview}
          onSynchronize={() => void openSynchronizationFromPublish()}
          onBranchErased={() => branches.selectBranch("main")}
          onOpenDiscard={() => setIsDiscardOpen(true)}
          onOpenPageDiff={openPageDiff}
          review={
            session
              ? {
                  href: session.focusHref,
                  title: session.focusedPage?.title ?? state.page?.title,
                  actions: (
                    <ReviewActions
                      session={session}
                      actions={review.actions}
                      canWrite={canWrite}
                      canPublish={canPublish}
                      finish={review.finish}
                      onReviewRemaining={(href) => {
                        review.setFilter("to_review")
                        state.setViewMode("diff")
                        if (href) review.focusOn(href)
                      }}
                      saveBuffer={state.saveBuffer}
                      onClosed={closeReview}
                    />
                  ),
                }
              : null
          }
        />

        <CreateBranchDialog
          projectId={projectId}
          from={branches.branchRef}
          open={isCreateOpen}
          initialName={createName}
          onOpenChange={setIsCreateOpen}
          onCreated={(branch) => branches.selectBranch(branch.id)}
        />
        <HistoryPanel
          projectId={projectId}
          mainVersionId={mainStatusData?.main.versionId ?? state.overview?.publishedVersion.id ?? null}
          canRestore={capabilities.can("docs.restore")}
          open={isHistoryOpen}
          onOpenChange={setIsHistoryOpen}
        />
        <SyncDialog
          projectId={projectId}
          branch={branches.branchRef}
          pages={state.pages}
          open={isSyncOpen}
          onOpenChange={setIsSyncOpen}
          onSynchronized={state.resetAfterExternalChange}
        />
        <DiscardChangesDialog
          branchName={branches.selectedBranch?.name ?? null}
          open={isDiscardOpen}
          onOpenChange={setIsDiscardOpen}
          isDiscarding={state.isDiscarding}
          onDiscard={async () => {
            await state.discardAllChanges()
            setIsDiscardOpen(false)
          }}
        />

        {/* The review strip spans the main area, so it reads as a state of the editor. */}
        {session ? (
          <ReviewBanner projectId={projectId} review={session.review} onExit={() => void review.exit()} />
        ) : review.review?.branch ? (
          <ReviewWaitingNotice pageCount={review.review.pages.length} onStart={() => void review.enter()} />
        ) : null}

        <div className="flex flex-col gap-3 px-4 pt-3 empty:hidden sm:px-6">
          {state.error ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}

          {review.actions.decideError ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{review.actions.decideError}</AlertDescription>
            </Alert>
          ) : null}

          {statusData && !session ? (
            <BranchStatusBanner
              status={statusData}
              onSynchronize={canWrite ? () => void openSynchronization() : null}
            />
          ) : null}
        </div>

        {/* While the content loads, the editor panes draw the skeleton, so it is
            the same one until the page arrives, with nothing remounting. */}
        {!state.isLoading && state.pages.length === 0 ? (
          <div className="surface-card m-4 px-4 py-10 text-center sm:m-6">
            <p className="font-mono text-xs font-bold tracking-[0.14em] text-foreground uppercase">
              No documentation yet
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Generate documentation first. The editor works on the published version.
            </p>
          </div>
        ) : session ? (
          <ReviewModeArea
            projectId={projectId}
            session={session}
            actions={review.actions}
            decisions={decisions}
            canWrite={canWrite}
            viewMode={state.viewMode}
            onViewModeChange={state.setViewMode}
            canvas={canvas}
            host={previewHost}
            liveDocsUrl={liveDocsUrl}
            onStep={review.focusOn}
            onFinish={() => review.finish.setOpen(true)}
            editor={editorPanes}
            editorPageHref={state.isPageLoading ? null : state.selectedHref}
          />
        ) : shownPageDiff ? (
          <BranchPageDiffPane
            projectId={projectId}
            branch={branches.branchRef}
            branchName={branchName}
            page={shownPageDiff}
            onClose={closePageDiff}
            onBackToRequest={approvalRequest ? backToRequest : undefined}
          />
        ) : (
          editorPanes
        )}
      </div>
    </EditorAssetsProvider>
  )
}

/**
 * Write: the page editor across the main area. Split: the MDX source on the
 * left, and the rendered page in a browser frame on the right.
 *
 * All modes read the same buffer, so a keystroke reaches the preview in the
 * same render, with no request and no debounce in between.
 */
function EditorPanes({
  state,
  tree,
  isMounted,
  WriteEditor,
  readOnly,
  canvas,
  previewHost,
  liveDocsUrl,
}: {
  state: ContentState
  tree: ContentTreeSection[]
  isMounted: boolean
  /** Null until the Write editor code is loaded. */
  WriteEditor: WriteEditorComponent | null
  /** True for a role without `docs.write`: the page reads, never edits. */
  readOnly: boolean
  canvas: CanvasSettings
  /** The address that the Split preview shows before the page path. */
  previewHost: string
  liveDocsUrl: string | null
}) {
  const mode = state.viewMode
  // One flag for every loading step, so the skeleton below stays the same
  // element from the first frame until the page shows.
  const isLoadingPage =
    state.isLoading ||
    state.selectedHref === null ||
    state.isPageLoading ||
    !isMounted ||
    (mode === "write" && WriteEditor === null)
  const { focusMode } = useShell()
  const siteConfig = state.overview?.siteConfig
  const { theme, mode: canvasMode, onModeChange: setCanvasMode } = canvas
  const { selectedHref, structure } = state
  const homeHref = useMemo(
    () => contentHomeHref(state.pages, state.navigation, siteConfig),
    [siteConfig, state.navigation, state.pages],
  )
  // A rename of the open page keeps it open at its new href (see `renamePage`).
  const slugEdit = useMemo<PageSlugEdit | null>(() => {
    const target = pageSlugTarget(tree, selectedHref)
    if (readOnly || !target || !selectedHref) return null
    return {
      prefix: target.prefix,
      slug: target.slug,
      onRename: (slug) => structure.renamePage(selectedHref, target.title, slug),
    }
  }, [readOnly, selectedHref, structure, tree])
  // The icon lives in the page's navigation entry, so a page outside every
  // section has nowhere to keep one.
  const iconEdit = useMemo<PageIconEdit | null>(() => {
    const path = findPagePath(tree, selectedHref)
    if (readOnly || !path || path.sectionSlug === "__other" || !selectedHref) return null
    const icon = state.pages.find((page) => page.href === selectedHref)?.icon ?? null
    return {
      icon,
      onChange: (next) => {
        structure.setPageIcon(selectedHref, next, { ownsError: true }).catch((cause: unknown) => {
          toast.error(getErrorMessage(cause, "The page icon could not be saved."))
        })
      },
    }
  }, [readOnly, selectedHref, state.pages, structure, tree])

  // An MDX issue opens its line in the source; from Write, Split opens first.
  const [reveal, setReveal] = useState<SourceReveal | null>(null)
  const { setViewMode, text } = state
  const showIssue = useCallback(
    (issue: DocsMdxIssue) => {
      if (issue.line === null) return
      setViewMode("split")
      setReveal({ offset: sourceOffset(text, issue.line, issue.column ?? 1) })
    },
    [setViewMode, text],
  )
  const issues = isLoadingPage ? null : (
    <PageMdxIssues issues={state.pageMdxIssues} onSelect={showIssue} />
  )

  const sourceEditor = isLoadingPage ? (
    <SourceSkeleton />
  ) : (
    <Suspense fallback={<SourceSkeleton />}>
      <MdxCodeEditor
        value={state.text}
        onChange={state.setText}
        onSave={() => void state.saveBuffer()}
        readOnly={readOnly || state.isDiscarding}
        reveal={reveal}
        onRevealed={() => setReveal(null)}
      />
    </Suspense>
  )

  if (mode === "split") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-row border-t border-border max-[820px]:flex-col">
          <section
            aria-label="Page source"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-border bg-card max-[820px]:border-r-0 max-[820px]:border-b"
          >
            {sourceEditor}
          </section>
          <section aria-label="Page preview" className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
            <PreviewFrame
              host={previewHost}
              href={selectedHref ?? "/"}
              open={{
                url: liveDocsUrl ? pageUrl(liveDocsUrl, selectedHref ?? "/") : null,
                label: "Open the live page",
                unavailableTitle: "The site is not published yet.",
              }}
              colorMode={hasLightMode(theme) ? { mode: canvasMode, onChange: setCanvasMode } : null}
            >
              {isLoadingPage ? (
                <PreviewSkeleton />
              ) : (
                <Suspense fallback={<PreviewSkeleton />}>
                  <SiteCanvas theme={theme} mode={canvasMode} className="min-h-full">
                    <MdxPreview source={state.text} />
                  </SiteCanvas>
                </Suspense>
              )}
            </PreviewFrame>
          </section>
        </div>
        {issues}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-row border-t border-border">
        <section aria-label="Page editor" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-editor">
          {isLoadingPage || !WriteEditor ? (
            <EditorSkeleton showOutline={!focusMode} />
          ) : (
            <WriteEditor
              // A new page is a new document, with its own undo history. A
              // renamed page keeps its key, so the editor stays as it is.
              key={state.editorKey}
              value={state.text}
              onChange={state.setText}
              onSave={() => void state.saveBuffer()}
              readOnly={readOnly || state.isDiscarding}
              page={{
                href: state.selectedHref,
                status: state.page?.status ?? null,
                slugEdit,
                iconEdit,
                isIndex: selectedHref !== null && selectedHref === homeHref,
              }}
              showOutline={!focusMode}
              canvas={canvas}
            />
          )}
        </section>
      </div>
      {issues}
    </div>
  )
}

function noop() {}

/**
 * Keeps the editor in step with review mode. Entering the review opens the
 * Diff view, leaving it returns from Diff to Write, and the focused review
 * page opens in the editor whenever the branch has it.
 */
function useReviewModeSync(
  state: ContentState,
  session: ReturnType<typeof useContentReview>["session"],
): void {
  const stateRef = useLatest(state)
  const isReviewing = session !== null
  const hasChanges = (session?.pages.length ?? 0) > 0
  const wasReviewingRef = useRef(false)
  useEffect(() => {
    if (isReviewing === wasReviewingRef.current) return
    wasReviewingRef.current = isReviewing
    const current = stateRef.current
    if (isReviewing) current.setViewMode(hasChanges ? "diff" : "write")
    else if (current.viewMode === "diff") current.setViewMode("write")
  }, [hasChanges, isReviewing, stateRef])

  const focusHref = session?.focusHref ?? null
  const { pages } = state
  useEffect(() => {
    if (!focusHref || !pages.some((page) => page.href === focusHref)) return
    void stateRef.current.selectPage(focusHref)
  }, [focusHref, pages, stateRef])
}
