import { useCallback, useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type {
  DocsContentEdit,
  DocsContentOverviewDto,
  DocsContentPageDto,
} from "@doxahq/contracts"
import type { BranchRef } from "@doxahq/contracts/docs-branches"

import {
  applyOptimisticMove,
  type ContentMoveEdit,
} from "~/lib/dashboard/content-drag"

import { getDocsBranchErrorMessage } from "~/lib/dashboard/docs-branch-errors"
import {
  dashboardQueryKeys,
  projectContentQueryOptions,
} from "~/lib/queries/dashboard"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"
import { applyProjectContentEdits } from "~/lib/platform-api"

export interface StructureEditOptions {
  /**
   * Runs once the server accepts the edit, before any query refetches. A
   * caller moves its own state here, so no render sees the old state against
   * the new data.
   */
  onApplied?: () => void
  /** The caller shows a failure next to its own control, so the page alert stays empty. */
  ownsError?: boolean
}

export interface ContentStructureActions {
  createSection: (slug: string, label: string) => Promise<string | null>
  createGroup: (sectionSlug: string, heading: string) => Promise<string | null>
  createPage: (
    sectionSlug: string,
    groupIndex: number | null,
    title: string,
    slug: string,
  ) => Promise<string | null>
  renameSection: (slug: string, label: string) => Promise<void>
  renameGroup: (
    sectionSlug: string,
    groupIndex: number,
    heading: string,
  ) => Promise<void>
  renamePage: (href: string, title: string, slug: string, options?: StructureEditOptions) => Promise<void>
  /** Sets or removes a page icon. The page list shows it before the server confirms. */
  setPageIcon: (href: string, icon: string | null, options?: StructureEditOptions) => Promise<void>
  /** Makes a page the one that the site root shows. The page list marks it before the server confirms. */
  setHomePage: (href: string) => Promise<void>
  /** The page that `setHomePage` is making the default, until the server answers. */
  pendingHomeHref: string | null
  deleteSection: (slug: string) => Promise<void>
  deleteGroup: (sectionSlug: string, groupIndex: number) => Promise<void>
  deletePage: (href: string) => Promise<void>
  moveNode: (edit: ContentMoveEdit) => Promise<void>
  isPending: boolean
  error: string | null
  clearError: () => void
}

/** Owns structure mutations without coupling them to the page-body autosave path. */
export function useContentStructure(
  projectId: string,
  branch: BranchRef,
): ContentStructureActions {
  const queryClient = useQueryClient()
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pendingHomeHref, setPendingHomeHref] = useState<string | null>(null)

  const apply = useCallback(
    async (edit: DocsContentEdit, options: StructureEditOptions = {}): Promise<void> => {
      setPendingCount((count) => count + 1)
      setError(null)
      try {
        await applyProjectContentEdits(projectId, { branch, edits: [edit] })
        options.onApplied?.()
        await queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.content(projectId, branch),
        })
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: docsBranchQueryKeys.status(projectId, branch),
          }),
          queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.list(projectId) }),
        ])
      } catch (cause) {
        const message = getDocsBranchErrorMessage(
          cause,
          "Failed to update the documentation structure.",
        )
        if (!options.ownsError) setError(message)
        throw new Error(message, { cause })
      } finally {
        setPendingCount((count) => count - 1)
      }
    },
    [branch, projectId, queryClient],
  )

  const applyAndFindNewHref = useCallback(
    async (edit: DocsContentEdit): Promise<string | null> => {
      const before = queryClient.getQueryData<{ pages: DocsContentPageDto[] }>(
        dashboardQueryKeys.content(projectId, branch),
      )
      const oldHrefs = new Set(before?.pages.map((page) => page.href) ?? [])
      await apply(edit)
      const overview = await queryClient.fetchQuery(projectContentQueryOptions(projectId, branch))
      return overview.pages.find((page) => !oldHrefs.has(page.href))?.href ?? null
    },
    [apply, branch, projectId, queryClient],
  )

  /**
   * Moves a node, and shows the result before the server confirms it.
   *
   * Without the prediction the row returns to its old place for the length of
   * the request, and the drop reads as a failure. Invalid or stale input returns
   * null, so the server remains the source of truth for rejected moves.
   */
  const moveNode = useCallback(
    async (edit: ContentMoveEdit): Promise<void> => {
      const key = dashboardQueryKeys.content(projectId, branch)
      const previous = queryClient.getQueryData<DocsContentOverviewDto>(key)
      const predicted = previous ? applyOptimisticMove(previous, edit) : null
      if (predicted) queryClient.setQueryData(key, predicted)

      try {
        await apply(edit)
      } catch (cause) {
        if (predicted && previous) queryClient.setQueryData(key, previous)
        throw cause
      }
    },
    [apply, branch, projectId, queryClient],
  )

  const setPageIcon = useCallback(
    async (href: string, icon: string | null, options?: StructureEditOptions): Promise<void> => {
      const key = dashboardQueryKeys.content(projectId, branch)
      const previous = queryClient.getQueryData<DocsContentOverviewDto>(key)
      if (previous) {
        queryClient.setQueryData(key, {
          ...previous,
          pages: previous.pages.map((page) => (page.href === href ? { ...page, icon } : page)),
        })
      }
      try {
        await apply({ type: "set_page_icon", href, icon }, options)
      } catch (cause) {
        if (previous) queryClient.setQueryData(key, previous)
        throw cause
      }
    },
    [apply, branch, projectId, queryClient],
  )

  const setHomePage = useCallback(
    async (href: string): Promise<void> => {
      const key = dashboardQueryKeys.content(projectId, branch)
      // A refetch already in flight would answer with the old default and
      // overwrite the prediction.
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<DocsContentOverviewDto>(key)
      setPendingHomeHref(href)
      if (previous) {
        const { published, working } = previous.siteConfig
        queryClient.setQueryData(key, {
          ...previous,
          siteConfig: { published, working: { ...(working ?? published), homePage: href } },
        })
      }
      // The list already shows the new default, so the spinner ends when the
      // server accepts the edit, not after the refetch that follows.
      const settle = () => setPendingHomeHref((current) => (current === href ? null : current))
      try {
        await apply({ type: "set_home_page", href }, { onApplied: settle })
      } catch (cause) {
        if (previous) queryClient.setQueryData(key, previous)
        throw cause
      } finally {
        settle()
      }
    },
    [apply, branch, projectId, queryClient],
  )

  return useMemo(() => ({
    createSection: (slug, label) =>
      applyAndFindNewHref({ type: "create_section", slug, label }),
    createGroup: (sectionSlug, heading) =>
      applyAndFindNewHref({ type: "create_group", sectionSlug, heading, starterPage: true }),
    createPage: (sectionSlug, groupIndex, title, slug) =>
      applyAndFindNewHref({ type: "create_page", sectionSlug, groupIndex, title, slug }),
    renameSection: (slug, label) => apply({ type: "rename_section", slug, label }),
    renameGroup: (sectionSlug, groupIndex, heading) =>
      apply({ type: "rename_group", sectionSlug, groupIndex, heading }),
    renamePage: (href, title, slug, options) =>
      apply({ type: "rename_page", href, title, slug }, options),
    deleteSection: (slug) => apply({ type: "delete_section", slug }),
    deleteGroup: (sectionSlug, groupIndex) =>
      apply({ type: "delete_group", sectionSlug, groupIndex }),
    deletePage: (href) => apply({ type: "delete_page", href }),
    setPageIcon,
    setHomePage,
    pendingHomeHref,
    moveNode,
    isPending: pendingCount > 0,
    error,
    clearError: () => setError(null),
  }), [apply, applyAndFindNewHref, error, moveNode, pendingCount, pendingHomeHref, setHomePage, setPageIcon])
}
