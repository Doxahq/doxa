import { Extension, type Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"

/**
 * Enter on an empty last line leaves a container, as in a list:
 *
 * - a note, a quote or a tab: the cursor moves to a new line after the note,
 *   the quote or the whole tab set;
 * - a step's body: a new step starts, with the cursor in its title;
 * - the empty title of the last, empty step: the step goes away and the
 *   cursor moves to a new line after the steps.
 *
 * Without this, the only way out of a container is the arrow keys or a click.
 */

/** Containers Enter leaves, and how many levels up the new line goes. */
const EXIT_LEVELS: Record<string, number> = {
  callout: 0,
  blockquote: 0,
  // A tab's panel sits in the tab set. The new line goes after the whole set.
  tabItem: 1,
}

function isEmptyParagraph(node: { type: { name: string }; content: { size: number } }): boolean {
  return node.type.name === "paragraph" && node.content.size === 0
}

function leaveContainer(editor: Editor): boolean {
  const { state } = editor
  const { selection } = state
  if (!selection.empty) return false
  const { $from } = selection
  if ($from.depth < 2 || !isEmptyParagraph($from.parent)) return false

  const containerDepth = $from.depth - 1
  const container = $from.node(containerDepth)
  const isLast = $from.index(containerDepth) === container.childCount - 1
  if (!isLast) return false
  const lineStart = $from.before()
  const lineEnd = $from.after()

  if (container.type.name === "stepBody") {
    const itemDepth = containerDepth - 1
    const after = $from.after(itemDepth)
    const tr = state.tr
    const step = state.schema.nodes.stepItem.create(null, [
      state.schema.nodes.stepTitle.create(),
      state.schema.nodes.stepBody.create(null, state.schema.nodes.paragraph.create()),
    ])
    tr.insert(after, step)
    if (container.childCount > 1) tr.delete(lineStart, lineEnd)
    const mapped = tr.mapping.map(after, -1)
    tr.setSelection(TextSelection.create(tr.doc, mapped + 2))
    editor.view.dispatch(tr.scrollIntoView())
    return true
  }

  const levels = EXIT_LEVELS[container.type.name]
  if (levels === undefined) return false
  const exitDepth = containerDepth - levels
  if (exitDepth < 1) return false
  const after = $from.after(exitDepth)
  const tr = state.tr.insert(after, state.schema.nodes.paragraph.create())
  if (container.childCount > 1) tr.delete(lineStart, lineEnd)
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(after, -1) + 1))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

/** Enter in the empty title of the last, empty step ends the steps. */
function endSteps(editor: Editor): boolean {
  const { state } = editor
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== "stepTitle" || $from.parent.content.size > 0) return false
  const itemDepth = $from.depth - 1
  const item = $from.node(itemDepth)
  const steps = $from.node(itemDepth - 1)
  const body = item.child(1)
  const bodyIsEmpty = body.childCount === 1 && isEmptyParagraph(body.child(0))
  if (!bodyIsEmpty || $from.index(itemDepth - 1) !== steps.childCount - 1 || steps.childCount < 2) return false

  const stepsEnd = $from.after(itemDepth - 1)
  const tr = state.tr.insert(stepsEnd, state.schema.nodes.paragraph.create())
  tr.delete($from.before(itemDepth), $from.after(itemDepth))
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(stepsEnd, -1) + 1))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

export const ContainerKeys = Extension.create({
  name: "containerKeys",
  // Before the node's own Enter handlers, such as the step title's.
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => endSteps(editor) || leaveContainer(editor),
    }
  },
})
