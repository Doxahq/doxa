import type { Editor } from "@tiptap/core"
import { NodeSelection, Selection } from "@tiptap/pm/state"

/**
 * Turns a selected block into a text cursor next to it, without focusing the
 * editor. The block loses its outline and its bar. A selection of text or a
 * block with no text around it stays as it is. Undo does not see the change.
 */
export function releaseBlockSelection(editor: Editor): boolean {
  const { state } = editor
  const { selection } = state
  if (!(selection instanceof NodeSelection)) return false
  const after = Selection.findFrom(state.doc.resolve(selection.to), 1, true)
  const next = after ?? Selection.findFrom(state.doc.resolve(selection.from), -1, true)
  if (!next) return false
  editor.view.dispatch(state.tr.setSelection(next).setMeta("addToHistory", false))
  return true
}
