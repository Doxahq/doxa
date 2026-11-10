import type { Editor, JSONContent } from "@tiptap/core"
import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { timeAgo } from "~/lib/dashboard/agent-activity-model"
import { stringifyEditorBlock } from "~/lib/editor/mdx-document"
import { parseMdxDocumentCached } from "~/lib/editor/mdx-document-cache"

/** One saved agent edit of a page. */
export interface AgentPageChange {
  /** The page source before the edit. */
  baseText: string
  /** The page source that the edit saved. */
  afterText: string
  changedAt: string
}

/** The agent edits of the open page, as the editor shows them. */
export interface AgentChangeView {
  /** Oldest first. */
  changes: readonly AgentPageChange[]
  /** The server's time now, for the age labels. */
  now: string
  /** Scroll to each new change. True while the person follows the agent. */
  reveal: boolean
  /** The edit that a person opened from the activity list. */
  reviewed: AgentPageChange | null
  /** False hides the marks. The changes stay known, so the marks return when this is true. */
  showMarks: boolean
}

interface MarkedBlock {
  changedAt: string
  /** True for a block of the edit that a person opened. */
  reviewed: boolean
}

const highlightKey = new PluginKey<DecorationSet>("agentChangeHighlight")
const CHANGED_CLASS = "doxa-agent-changed"
const REVIEWED_CLASS = "doxa-agent-reviewed"
const NO_MARKS: ReadonlyMap<number, MarkedBlock> = new Map()

/** Holds the tint and the label on the blocks that an agent changed. They follow later edits. */
export const AgentChangeHighlight = Extension.create({
  name: "agentChangeHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: highlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (transaction, current) =>
            (transaction.getMeta(highlightKey) as DecorationSet | undefined) ??
            current.map(transaction.mapping, transaction.doc),
        },
        props: { decorations: (state) => highlightKey.getState(state) },
      }),
    ]
  },
})

interface ChangeBlocks {
  before: ReadonlySet<string>
  after: ReadonlySet<string>
}

const blocksOfChange = new WeakMap<AgentPageChange, ChangeBlocks>()

function pageBlocks(source: string): ReadonlySet<string> {
  return new Set((parseMdxDocumentCached(source).content.content ?? []).map(stringifyEditorBlock))
}

/** Parsed once per edit: the labels and each new edit ask again. */
function changeBlocks(change: AgentPageChange): ChangeBlocks {
  const known = blocksOfChange.get(change)
  if (known) return known
  const blocks = { before: pageBlocks(change.baseText), after: pageBlocks(change.afterText) }
  blocksOfChange.set(change, blocks)
  return blocks
}

function editMadeBlock(change: AgentPageChange, block: string): boolean {
  const { before, after } = changeBlocks(change)
  return after.has(block) && !before.has(block)
}

/**
 * Pure: when an agent last changed each top-level block of `doc`, by index. A
 * block that no agent edit made is left out, also one that a person wrote
 * between two edits. A block keeps the time of the edit that made it, so the
 * marks of earlier edits stay while the agent goes on.
 */
export function changedBlockTimes(doc: JSONContent, changes: readonly AgentPageChange[]): ReadonlyMap<number, string> {
  const times = new Map<number, string>()
  const newestFirst = [...changes].reverse()
  ;(doc.content ?? []).forEach((block, index) => {
    const text = stringifyEditorBlock(block)
    if (!text) return
    const change = newestFirst.find((candidate) => editMadeBlock(candidate, text))
    if (change) times.set(index, change.changedAt)
  })
  return times
}

/** Pure: the label of a changed block. CSS writes it in capitals. */
export function changeAgeLabel(changedAt: string, now: string): string {
  const age = timeAgo(changedAt, now)
  return age === "just now" ? "Just now" : `Changed ${age}`
}

/** By block index. The reviewed edit comes last, so its marks win. */
function markedBlocks(doc: JSONContent, view: AgentChangeView | null): ReadonlyMap<number, MarkedBlock> {
  const marks = new Map<number, MarkedBlock>()
  changedBlockTimes(doc, view?.changes ?? []).forEach((changedAt, index) => {
    marks.set(index, { changedAt, reviewed: false })
  })
  if (view?.reviewed) {
    changedBlockTimes(doc, [view.reviewed]).forEach((changedAt, index) => {
      marks.set(index, { changedAt, reviewed: true })
    })
  }
  return marks
}

function changedBlockDecoration(from: number, to: number, mark: MarkedBlock, now: string): Decoration {
  const attributes = {
    class: mark.reviewed ? `${CHANGED_CLASS} ${REVIEWED_CLASS}` : CHANGED_CLASS,
    "data-agent-change": changeAgeLabel(mark.changedAt, now),
  }
  return Decoration.node(from, to, attributes, mark)
}

function setDecorations(editor: Editor, decorations: Decoration[]): void {
  const { state, view } = editor
  view.dispatch(state.tr.setMeta(highlightKey, DecorationSet.create(state.doc, decorations)))
}

function currentDecorations(editor: Editor): Decoration[] {
  return highlightKey.getState(editor.state)?.find() ?? []
}

function drawChangedBlocks(editor: Editor, marks: ReadonlyMap<number, MarkedBlock>, now: string): void {
  if (marks.size === 0 && currentDecorations(editor).length === 0) return
  const decorations: Decoration[] = []
  editor.state.doc.forEach((node, offset, index) => {
    const mark = marks.get(index)
    if (mark !== undefined) decorations.push(changedBlockDecoration(offset, offset + node.nodeSize, mark, now))
  })
  setDecorations(editor, decorations)
}

function revealBlock(editor: Editor, index: number): void {
  const { doc } = editor.state
  let position = 0
  for (let child = 0; child < index; child += 1) position += doc.child(child).nodeSize
  const element = editor.view.nodeDOM(position)
  if (element instanceof HTMLElement) element.scrollIntoView({ block: "center" })
}

/**
 * Marks the blocks of `doc`, which the editor shows. Scrolls to the first block
 * of the reviewed edit or, with `reveal`, of a change that it did not show yet.
 */
export function showAgentChanges(
  editor: Editor,
  doc: JSONContent,
  view: AgentChangeView | null,
  revealedChange: { current: string | null },
): void {
  const marks = markedBlocks(doc, view)
  drawChangedBlocks(editor, view?.showMarks ? marks : NO_MARKS, view?.now ?? "")
  const target = view?.reviewed?.changedAt ?? (view?.reveal ? view.changes.at(-1)?.changedAt : undefined)
  if (target === undefined) {
    // A second click on the same edit must scroll to it again.
    revealedChange.current = null
    return
  }
  if (target === revealedChange.current) return
  const blocks = [...marks].filter(([, mark]) => mark.changedAt === target).map(([index]) => index)
  if (blocks.length === 0) return
  revealedChange.current = target
  revealBlock(editor, Math.min(...blocks))
}

/** Updates the age labels. Each mark stays on its block, also after a person's edits. */
export function refreshChangeAges(editor: Editor, now: string): void {
  const marks = currentDecorations(editor)
  if (marks.length === 0) return
  setDecorations(
    editor,
    marks.map(({ from, to, spec }) => {
      const mark: MarkedBlock = spec
      return changedBlockDecoration(from, to, mark, now)
    }),
  )
}
