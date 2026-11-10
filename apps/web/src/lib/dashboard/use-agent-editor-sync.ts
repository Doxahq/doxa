import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { AgentActivitySnapshot, AgentLiveEvent } from "@doxahq/contracts/agent-live-activity"
import type { BranchRef } from "@doxahq/contracts/docs-branches"

import { revertUnifiedDiff } from "~/lib/dashboard/revert-unified-diff"
import type { AgentPageChange } from "~/lib/editor/agent-change-highlight"
import { agentActivityDiffQueryOptions } from "~/lib/queries/agent-activity"
import {
  dashboardQueryKeys,
  projectContentPageQueryOptions,
  projectContentQueryOptions,
} from "~/lib/queries/dashboard"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"
import { fetchLatest } from "~/lib/queries/fetch-latest"

interface EditorControls {
  selectedHref: string | null
  text: string
  isDirty: boolean
  /** Gives the new text of the open page, or null when it cannot load. */
  reloadOpenPage: () => Promise<string | null>
  selectPage: (href: string) => Promise<unknown> | unknown
}

type PageChanges = ReadonlyMap<string, readonly AgentPageChange[]>

/** The edit that a person opened from the activity list. */
interface ReviewedEdit {
  seq: number
  branch: string
  href: string
  /** Null while it loads, or when the stored diffs no longer fit the page. */
  change: AgentPageChange | null
}

const NO_PAGE_CHANGES: PageChanges = new Map()
const NO_CHANGES: readonly AgentPageChange[] = []
/** The source of a page for each edit stays in memory, so this bounds it. */
const MAX_CHANGES_PER_PAGE = 10

/** A sync brings the changes of main into the branch, but it is a branch action in the feed. */
function changesBranchContent(event: AgentLiveEvent): boolean {
  return event.kind === "edit" || event.tool === "sync_branch"
}

/** Pure: the events on this branch after `afterSeq` that changed its content, newest first. */
export function newContentChanges(
  snapshot: AgentActivitySnapshot,
  afterSeq: number,
  branch: BranchRef,
): AgentLiveEvent[] {
  return snapshot.events.filter(
    (event) => event.seq > afterSeq && event.branchId === branch && changesBranchContent(event),
  )
}

function withPageChange(current: PageChanges, href: string, change: AgentPageChange): PageChanges {
  const changes = [...(current.get(href) ?? NO_CHANGES), change]
    .sort((first, second) => first.changedAt.localeCompare(second.changedAt))
    .slice(-MAX_CHANGES_PER_PAGE)
  return new Map(current).set(href, changes)
}

/** The source of a page before `edits` (newest first). Null when a stored diff is missing or does not fit. */
async function sourceBeforeEdits(
  queryClient: QueryClient,
  projectId: string,
  source: string,
  edits: readonly AgentLiveEvent[],
): Promise<string | null> {
  let text: string | null = source
  for (const edit of edits) {
    if (text === null || !edit.hasDiff) return null
    text = revertUnifiedDiff(text, await queryClient.fetchQuery(agentActivityDiffQueryOptions(projectId, edit.seq)))
  }
  return text
}

/** Pure: the later edits of the same page, newest first. Undoing them gives the text that `edit` saved. */
export function editsAfter(events: readonly AgentLiveEvent[], edit: AgentLiveEvent): AgentLiveEvent[] {
  return events.filter(
    (event) =>
      event.seq > edit.seq &&
      event.kind === "edit" &&
      event.branchId === edit.branchId &&
      event.pageHref === edit.pageHref,
  )
}

/** What `edits` changed in a page that reads `source` after `laterEdits`. Both are newest first. */
async function changeOfEdits(
  queryClient: QueryClient,
  projectId: string,
  source: string,
  laterEdits: readonly AgentLiveEvent[],
  edits: readonly AgentLiveEvent[],
): Promise<AgentPageChange | null> {
  const afterText = await sourceBeforeEdits(queryClient, projectId, source, laterEdits).catch(() => null)
  if (afterText === null) return null
  const baseText = await sourceBeforeEdits(queryClient, projectId, afterText, edits).catch(() => null)
  const changedAt = edits[0]?.occurredAt
  return baseText === null || changedAt === undefined ? null : { baseText, afterText, changedAt }
}

/**
 * Loads a page that an agent edited and that the editor does not have open.
 * Null when it cannot open, for example when the edit deleted it. The change
 * is null when the page opens without marks.
 */
async function loadEditedPage(input: {
  queryClient: QueryClient
  projectId: string
  branch: BranchRef
  href: string
  edits: readonly AgentLiveEvent[]
}): Promise<{ change: AgentPageChange | null } | null> {
  const { queryClient, projectId, branch, href, edits } = input
  const page = await fetchLatest(queryClient, projectContentPageQueryOptions(projectId, branch, href))
  if (page === null) return null
  const afterText = page.workingContent ?? page.publishedContent
  return { change: await changeOfEdits(queryClient, projectId, afterText, [], edits) }
}

/**
 * Keeps the open editor in step with an agent: reloads the page that it
 * changed, follows it to other pages, and keeps what each edit changed, so
 * that the editor can mark it. It never touches unsaved work.
 */
export function useAgentEditorSync(input: {
  projectId: string
  branch: BranchRef
  snapshot: AgentActivitySnapshot | null
  state: EditorControls
}) {
  const { projectId, branch, snapshot, state } = input
  const queryClient = useQueryClient()
  const [follow, setFollow] = useState(true)
  const [pageChanges, setPageChanges] = useState<PageChanges>(NO_PAGE_CHANGES)
  const stateRef = useRef(state)
  stateRef.current = state
  const followRef = useRef(follow)
  followRef.current = follow
  const seenSeq = useRef<number | null>(null)
  const followedHref = useRef<string | null>(null)
  /** A newer edit cancels a page switch that is still loading. */
  const latestReaction = useRef(0)
  const [reviewed, setReviewed] = useState<ReviewedEdit | null>(null)
  const reviewedRef = useRef(reviewed)
  reviewedRef.current = reviewed

  const latestSeq = snapshot?.latestSeq ?? null
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  useEffect(() => {
    const current = snapshotRef.current
    if (current === null || latestSeq === null) return
    const previous = seenSeq.current
    seenSeq.current = latestSeq
    // The first snapshot is history, and the page already loaded with it.
    if (previous === null || latestSeq <= previous) return
    const edits = newContentChanges(current, previous, branch)
    if (edits.length === 0) return

    void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.content(projectId, branch) })
    void queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.status(projectId, branch) })

    const editor = stateRef.current
    if (editor.isDirty) return
    latestReaction.current += 1
    const reaction = latestReaction.current

    const openHref = editor.selectedHref
    const editOfOpenPage = openHref === null ? undefined : edits.find((edit) => edit.pageHref === openHref)
    if (openHref !== null && editOfOpenPage !== undefined) {
      const baseText = editor.text
      void editor.reloadOpenPage().then((afterText) => {
        if (afterText === null) return
        setPageChanges((changes) =>
          withPageChange(changes, openHref, { baseText, afterText, changedAt: editOfOpenPage.occurredAt }),
        )
      })
      return
    }

    const target = edits.find((edit) => edit.pageHref !== null)?.pageHref ?? null
    if (target === null || !followRef.current) return
    void (async () => {
      const [, edited] = await Promise.all([
        // A new page must be in the page list before the editor opens it.
        fetchLatest(queryClient, projectContentQueryOptions(projectId, branch)),
        loadEditedPage({
          queryClient,
          projectId,
          branch,
          href: target,
          edits: edits.filter((edit) => edit.pageHref === target),
        }),
      ])
      if (edited === null) return
      const { change } = edited
      // Kept even when the switch is canceled, so a later visit shows this edit.
      if (change !== null) setPageChanges((changes) => withPageChange(changes, target, change))
      if (reaction !== latestReaction.current || !followRef.current || stateRef.current.isDirty) return
      followedHref.current = target
      await stateRef.current.selectPage(target)
    })()
  }, [branch, latestSeq, projectId, queryClient])

  // A person who opens another page takes over, so the editor stops following.
  const selectedHref = state.selectedHref
  const previousSelection = useRef({ branch, href: selectedHref })
  useEffect(() => {
    const previous = previousSelection.current
    previousSelection.current = { branch, href: selectedHref }
    if (previous.branch !== branch) {
      const isReviewingHere = reviewedRef.current?.branch === branch
      setFollow(!isReviewingHere)
      if (!isReviewingHere) setReviewed(null)
      setPageChanges(NO_PAGE_CHANGES)
      return
    }
    if (previous.href === null || selectedHref === null || previous.href === selectedHref) return
    if (selectedHref !== followedHref.current) setFollow(false)
  }, [branch, selectedHref])

  // Runs again after a branch switch, because the reviewed edit can be on the next branch.
  const reviewedSeq = reviewed?.seq ?? null
  useEffect(() => {
    const target = reviewedRef.current
    if (target !== null && target.branch === branch) void stateRef.current.selectPage(target.href)
  }, [branch, reviewedSeq])

  /** Opens the page of an edit and marks that edit. A review stops following, so the page stays. */
  const reviewEdit = useCallback(
    (edit: AgentLiveEvent | null) => {
      if (edit === null || edit.branchId === null || edit.pageHref === null) {
        setReviewed(null)
        return
      }
      const { seq, branchId: editBranch, pageHref: href } = edit
      latestReaction.current += 1
      setFollow(false)
      setReviewed({ seq, branch: editBranch, href, change: null })
      void fetchLatest(queryClient, projectContentPageQueryOptions(projectId, editBranch, href))
        .then((page) => {
          if (page === null) return null
          const laterEdits = editsAfter(snapshotRef.current?.events ?? [], edit)
          return changeOfEdits(queryClient, projectId, page.workingContent ?? page.publishedContent, laterEdits, [edit])
        })
        .then((change) => setReviewed((current) => (current?.seq === seq ? { ...current, change } : current)))
    },
    [projectId, queryClient],
  )

  return {
    follow,
    setFollow,
    reviewEdit,
    /** The edit that a person reviews, when the editor has its page open. */
    reviewed: reviewed !== null && reviewed.branch === branch && reviewed.href === selectedHref ? reviewed.change : null,
    /** The agent's edits of the open page, oldest first. */
    changes: (selectedHref === null ? undefined : pageChanges.get(selectedHref)) ?? NO_CHANGES,
  }
}
