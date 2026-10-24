import { startTransition, useCallback, useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  DocsContentEdit,
  DocsContentMdxReport,
  DocsContentOverviewDto,
  DocsPageMdxIssues,
  DocsContentPageDetailDto,
} from "@doxahq/contracts"
import { branchRefSchema, type BranchRef } from "@doxahq/contracts/docs-branches"
import { getDocsBranchErrorMessage, isMissingPageError } from "~/lib/dashboard/docs-branch-errors"
import {
  dashboardQueryKeys,
  projectContentMdxReportQueryOptions,
  projectContentPageQueryOptions,
  projectContentQueryOptions,
} from "~/lib/queries/dashboard"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"
import {
  applyProjectContentEdits,
  discardProjectContentBranch,
} from "~/lib/platform-api"
import {
  CONTENT_STRUCTURE_SAVE_REQUIRED_MESSAGE,
  contentDeleteIncludesPage,
  runContentDelete,
  type ContentDeleteEdit,
} from "~/lib/dashboard/content-delete"
import { movesAcrossSections } from "~/lib/dashboard/content-drag"
import { buildContentTree, contentHomeHref } from "~/lib/dashboard/content-navigation"
import {
  followPageRename,
  pageHrefFromSlug,
  pageSlugTarget,
  renamedPageDetail,
} from "~/lib/dashboard/page-slug"
import { useContentStructure } from "~/lib/dashboard/use-content-structure"
import { useDraftBuffer, type DraftBufferSource } from "~/lib/dashboard/use-draft-buffer"
import { issuesForPage, withSavedPageIssues } from "~/lib/dashboard/mdx-issues"

/**
 * Write: the rich page editor. Split: the MDX source beside the rendered
 * preview. Diff: what a generation changes on the page, only in review mode.
 * There is no preview-only mode.
 */
export type ContentViewMode = "write" | "split" | "diff"

interface PageSelection {
  branch: BranchRef
  href: string | null
  /**
   * Changes when another page opens, and stays when the open page is renamed.
   * The editor uses it as its key, so a rename keeps the editor and its undo
   * history.
   */
  editorKey: number
  /** The href the open page had before a rename the overview has not confirmed. */
  renamedFrom: string | null
  /**
   * True while the page is the one the URL asked for, before any other page
   * opened. Such a page loads before the overview arrives, so the overview
   * may still show that it does not exist.
   */
  fromRequest: boolean
}

/** The page row that the person clicked, before the editor opens the page. */
interface PageClick {
  branch: BranchRef
  href: string
}

/**
 * Owns the docs content editor state for one project.
 *
 * Edits are sent as an edit list, the same operation set a future AI writer or
 * MCP client uses. The branch travels with every request and cache key.
 */
export function useProjectContent(
  projectId: string,
  branch: BranchRef,
  options: {
    /**
     * The page to open first, for example from the URL after a reload. A
     * page that does not exist on the branch falls back to the default page.
     */
    requestedHref?: string | null
  } = {},
) {
  const { requestedHref = null } = options
  const queryClient = useQueryClient()
  // The page from the URL loads at once, in parallel with the overview. The
  // overview then confirms it, or the effect below opens the default page.
  const [selection, setSelection] = useState<PageSelection>(() => ({
    branch,
    href: requestedHref,
    editorKey: 0,
    renamedFrom: null,
    fromRequest: requestedHref !== null,
  }))
  const selectedHref = selection.branch === branch ? selection.href : null
  const renamedFrom = selection.branch === branch ? selection.renamedFrom : null
  // The clicked row shows as selected at once. The editor swap that follows
  // is a transition, so it never delays that paint.
  const [click, setClick] = useState<PageClick | null>(null)
  const clickedHref = click?.branch === branch ? click.href : null
  /** Opens a page. Opening the page that is already open changes nothing. */
  const openPage = useCallback(
    (href: string) =>
      setSelection((current) =>
        current.branch === branch && current.href === href
          ? current
          : { branch, href, editorKey: current.editorKey + 1, renamedFrom: null, fromRequest: false },
      ),
    [branch],
  )
  const [viewMode, setViewMode] = useState<ContentViewMode>("write")
  const structureMutations = useContentStructure(projectId, branch)

  const overviewQuery = useQuery(projectContentQueryOptions(projectId, branch))
  const pageQuery = useQuery(projectContentPageQueryOptions(projectId, branch, selectedHref))
  // The pages that fail the MDX check. The editor shows the open page's
  // issues, and the publish menu waits until the list is empty.
  const mdxReportQuery = useQuery(projectContentMdxReportQueryOptions(projectId, branch))

  const loadedOverview = overviewQuery.data ?? null
  const overview = useMemo(
    () =>
      loadedOverview && renamedFrom && selectedHref
        ? followPageRename(loadedOverview, renamedFrom, selectedHref)
        : loadedOverview,
    [loadedOverview, renamedFrom, selectedHref],
  )
  const pages = useMemo(() => overview?.pages ?? [], [overview])
  const navigation = useMemo(() => overview?.navigation ?? [], [overview])
  const isSelectionListed = selectedHref !== null && pages.some((page) => page.href === selectedHref)
  // A page from the URL that the overview does not list is a stale link. Its
  // request may have failed already. The page stays loading until the effect
  // below opens the default page, so no error and no empty editor show first.
  const isRequestUnconfirmed = selection.fromRequest && selectedHref !== null && !isSelectionListed
  const isRequestStale = isRequestUnconfirmed && overview !== null && pages.length > 0

  // As soon as the manifest arrives, open the requested page, else the
  // default page (the one the site root shows). Do it again when the
  // selected page disappears, for example after a new generation or a delete.
  // The request only picks a page when none is open: the URL follows the
  // open page, never the other way, so a rename cannot reopen the old href.
  const siteConfig = overview?.siteConfig
  useEffect(() => {
    if (pages.length === 0) return
    if (selectedHref && pages.some((page) => page.href === selectedHref)) return
    const requested =
      !selectedHref && requestedHref && pages.some((page) => page.href === requestedHref) ? requestedHref : null
    openPage(requested ?? contentHomeHref(pages, navigation, siteConfig) ?? pages[0].href)
  }, [navigation, openPage, pages, requestedHref, selectedHref, siteConfig])

  // The loaded overview confirms a rename once it lists the new href.
  useEffect(() => {
    if (!renamedFrom || !loadedOverview?.pages.some((page) => page.href === selectedHref)) return
    setSelection((current) => (current.renamedFrom ? { ...current, renamedFrom: null } : current))
  }, [loadedOverview, renamedFrom, selectedHref])

  const editMutation = useMutation({
    mutationFn: (input: { branch: BranchRef; edits: DocsContentEdit[] }) =>
      applyProjectContentEdits(projectId, { branch: input.branch, edits: input.edits }),
    onSuccess: (_working, input) => {
      void queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.content(projectId, input.branch),
      })
      void queryClient.invalidateQueries({
        queryKey: docsBranchQueryKeys.status(projectId, input.branch),
      })
      void queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.list(projectId) })
    },
  })

  // The buffer loads once per branch and page. Working text wins over the base
  // text so an editor returning to a page continues where they stopped.
  const pageSource = useMemo((): DraftBufferSource<string> | null => {
    const page = pageQuery.data
    return page
      ? { key: pageBufferKey(branch, page.href), value: page.workingContent ?? page.publishedContent }
      : null
  }, [branch, pageQuery.data])

  const buffer = useDraftBuffer<string>({
    source: pageSource,
    save: async (text, key) => {
      const target = readPageBufferKey(key)
      if (!target) throw new Error("The editor buffer has an invalid page key.")
      const saved = await editMutation.mutateAsync({
        branch: target.branch,
        edits: [{ type: "set_page_content", href: target.href, content: text }],
      })
      // The save stands even with MDX issues; its result shows them at once.
      queryClient.setQueryData(
        dashboardQueryKeys.contentMdxReport(projectId, target.branch),
        (report: DocsContentMdxReport | undefined) =>
          report ? withSavedPageIssues(report, [target.href], saved.mdxIssues) : report,
      )
      queryClient.setQueryData(
        dashboardQueryKeys.contentPage(projectId, target.branch, target.href),
        (page: DocsContentPageDetailDto | undefined) =>
          page ? { ...page, status: "edited" as const, workingContent: text } : page,
      )
    },
  })

  const isDirty = buffer.isDirty
  const working = overview?.working ?? null
  /** True when anything is unpublished, saved to the branch or still in the buffer. */
  const hasChanges = isDirty || (working?.changeCount ?? 0) > 0

  const discardMutation = useMutation({
    mutationFn: () => discardProjectContentBranch(projectId, branch),
    onSuccess: resetCaches,
  })

  function resetCaches() {
    buffer.reset()
    void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.content(projectId, branch) })
    void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) })
    void queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.project(projectId) })
  }

  /** Writes the buffer to the selected branch. Returns false when the save failed. */
  const saveBuffer = buffer.flush

  const selectPage = useCallback(
    async (href: string) => {
      if (selectedHref === href) return
      setClick({ branch, href })
      const clearClick = () => setClick((current) => (current?.href === href ? null : current))
      if (!(await saveBuffer())) {
        clearClick()
        return
      }
      // The new editor mounts in a transition, after the row paints.
      startTransition(() => {
        openPage(href)
        clearClick()
      })
    },
    [branch, openPage, saveBuffer, selectedHref],
  )

  const setText = buffer.setValue

  async function resetPage() {
    if (!selectedHref) return
    try {
      await editMutation.mutateAsync({
        branch,
        edits: [{ type: "reset_page", href: selectedHref }],
      })
    } catch {
      return
    }
    buffer.reset()
    await queryClient.invalidateQueries({
      queryKey: dashboardQueryKeys.contentPage(projectId, branch, selectedHref),
    })
  }

  async function discardAllChanges() {
    await discardMutation.mutateAsync().catch(() => undefined)
  }

  const resetAfterExternalChange = useCallback(() => {
    buffer.reset()
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryKeys.content(projectId, branch),
    })
  }, [branch, buffer, projectId, queryClient])

  const requireSavedBuffer = useCallback(async (): Promise<void> => {
    if (!(await saveBuffer())) {
      throw new Error(CONTENT_STRUCTURE_SAVE_REQUIRED_MESSAGE)
    }
  }, [saveBuffer])

  const { suspend: suspendBuffer, waitForPendingSaves, rekey: rekeyBuffer } = buffer

  /**
   * Renames the open page and keeps it open at its new href.
   *
   * Once the server accepts the rename, one state update moves the selection,
   * the buffer and the cached page detail to the new href, before any refetch.
   * The editor keeps its key, so the page does not reload, and the old href is
   * never requested again.
   */
  const renameOpenPage = useCallback(
    async (href: string, title: string, slug: string, to: string) => {
      await requireSavedBuffer()
      await structureMutations.renamePage(href, title, slug, {
        ownsError: true,
        onApplied: () => {
          const pageKey = (target: string) => dashboardQueryKeys.contentPage(projectId, branch, target)
          const previous = queryClient.getQueryData<DocsContentPageDetailDto>(pageKey(href))
          if (previous) queryClient.setQueryData(pageKey(to), renamedPageDetail(previous, to))
          queryClient.removeQueries({ queryKey: pageKey(href), exact: true })
          rekeyBuffer(pageBufferKey(branch, href), pageBufferKey(branch, to))
          // A second rename can start before the overview confirms the first.
          // The follow then starts from the href that the loaded overview lists.
          const loaded = queryClient.getQueryData<DocsContentOverviewDto>(
            dashboardQueryKeys.content(projectId, branch),
          )
          const listed = loaded?.pages.some((page) => page.href === href) ?? false
          setSelection((current) =>
            current.branch === branch && current.href === href
              ? { ...current, href: to, renamedFrom: listed ? href : (current.renamedFrom ?? href) }
              : current,
          )
        },
      })
    },
    [branch, projectId, queryClient, rekeyBuffer, requireSavedBuffer, structureMutations],
  )

  const deleteWithBufferPolicy = useCallback(
    <Result,>(edit: ContentDeleteEdit, deleteContent: () => Promise<Result>) =>
      runContentDelete({
        deletesSelectedPage: contentDeleteIncludesPage(
          edit,
          selectedHref,
          navigation,
        ),
        saveBuffer,
        suspendBuffer,
        waitForPendingSaves,
        deleteContent,
      }),
    [navigation, saveBuffer, selectedHref, suspendBuffer, waitForPendingSaves],
  )

  const structure = useMemo(() => ({
    ...structureMutations,
    createSection: async (...args: Parameters<typeof structureMutations.createSection>) => {
      await requireSavedBuffer()
      return structureMutations.createSection(...args)
    },
    createGroup: async (...args: Parameters<typeof structureMutations.createGroup>) => {
      await requireSavedBuffer()
      return structureMutations.createGroup(...args)
    },
    createPage: async (...args: Parameters<typeof structureMutations.createPage>) => {
      await requireSavedBuffer()
      return structureMutations.createPage(...args)
    },
    renameSection: async (...args: Parameters<typeof structureMutations.renameSection>) => {
      await requireSavedBuffer()
      return structureMutations.renameSection(...args)
    },
    renameGroup: async (...args: Parameters<typeof structureMutations.renameGroup>) => {
      await requireSavedBuffer()
      return structureMutations.renameGroup(...args)
    },
    renamePage: async (...args: Parameters<typeof structureMutations.renamePage>) => {
      const [href, title, slug] = args
      const target = href === selectedHref ? pageSlugTarget(buildContentTree(pages, navigation), href) : null
      if (target) return renameOpenPage(href, title, slug, pageHrefFromSlug(target.prefix, slug))
      await requireSavedBuffer()
      return structureMutations.renamePage(...args)
    },
    deleteSection: (slug: string) => deleteWithBufferPolicy(
      { type: "delete_section", slug },
      () => structureMutations.deleteSection(slug),
    ),
    deleteGroup: (sectionSlug: string, groupIndex: number) => deleteWithBufferPolicy(
      { type: "delete_group", sectionSlug, groupIndex },
      () => structureMutations.deleteGroup(sectionSlug, groupIndex),
    ),
    deletePage: (href: string) => deleteWithBufferPolicy(
      { type: "delete_page", href },
      () => structureMutations.deletePage(href),
    ),
    moveNode: async (edit: Parameters<typeof structureMutations.moveNode>[0]) => {
      // A move writes the open buffer first only when it changes that page's
      // href. Moves inside one section leave all page bodies untouched.
      if (movesAcrossSections(edit, selectedHref, navigation)) {
        await requireSavedBuffer()
      }
      return structureMutations.moveNode(edit)
    },
  }), [
    deleteWithBufferPolicy,
    navigation,
    pages,
    renameOpenPage,
    requireSavedBuffer,
    selectedHref,
    structureMutations,
  ])

  const errors = [
    overviewQuery.error
      ? getDocsBranchErrorMessage(overviewQuery.error, "Failed to load docs content.")
      : null,
    pageQuery.error && !isRequestUnconfirmed && !isMissingPageError(pageQuery.error)
      ? getDocsBranchErrorMessage(pageQuery.error, "Failed to load this page.")
      : null,
    editMutation.error
      ? getDocsBranchErrorMessage(editMutation.error, "Failed to save the changes.")
      : null,
    discardMutation.error
      ? getDocsBranchErrorMessage(discardMutation.error, "Failed to discard the changes.")
      : null,
    structureMutations.error,
  ]

  return {
    overview,
    pages,
    navigation,
    selectedHref,
    /**
     * The page the sidebar marks as selected: the clicked page from the click
     * on, else the open page.
     */
    highlightedHref: clickedHref ?? selectedHref,
    selectPage,
    editorKey: `${branch}:${selection.editorKey}`,
    page: pageQuery.data ?? null,
    // The buffer loads one render after the page query resolves. Falling back to
    // the query result for that render stops the previous page from flashing.
    text:
      selectedHref !== null && buffer.key === pageBufferKey(branch, selectedHref) && buffer.value !== null
        ? buffer.value
        : (pageQuery.data?.workingContent ?? pageQuery.data?.publishedContent ?? ""),
    setText,
    isDirty,
    hasChanges,
    viewMode,
    setViewMode,
    saveBuffer,
    resetPage,
    discardAllChanges,
    resetAfterExternalChange,
    structure,
    /** Changed pages that fail the MDX check; a publish waits until it is empty. */
    mdxIssuePages: mdxReportQuery.data?.pages ?? NO_MDX_ISSUE_PAGES,
    /** The MDX issues of the open page, from its last save. */
    pageMdxIssues: issuesForPage(mdxReportQuery.data, selectedHref),
    isLoading: overviewQuery.isPending,
    isOverviewRefreshing: overviewQuery.isFetching,
    isPageLoading: (pageQuery.isPending && selectedHref !== null) || isRequestStale,
    isSaving: editMutation.isPending,
    isDiscarding: discardMutation.isPending,
    error: errors.find((message) => message !== null) ?? null,
  }
}

const NO_MDX_ISSUE_PAGES: readonly DocsPageMdxIssues[] = []

function pageBufferKey(branch: BranchRef, href: string): string {
  return `${branch}\u0000${href}`
}

function readPageBufferKey(key: string): { branch: BranchRef; href: string } | null {
  const separator = key.indexOf("\u0000")
  if (separator < 0) return null
  const parsed = branchRefSchema.safeParse(key.slice(0, separator))
  const href = key.slice(separator + 1)
  return parsed.success && href.startsWith("/") ? { branch: parsed.data, href } : null
}
