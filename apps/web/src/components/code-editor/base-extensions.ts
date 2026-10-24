import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search"
import type { Extension } from "@codemirror/state"
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view"

import { editorTheme, highlightStyle } from "~/components/code-editor/editor-theme"

interface BaseExtensionsOptions {
  /** The language slot. Callers pass a compartment so the language can change. */
  language: Extension
  /** The read-only slot, also a compartment. */
  readOnly: Extension
  onSave: () => void
  onChange: (value: string) => void
  ariaLabel?: string
}

/**
 * The editor setup every Doxa code editor shares.
 *
 * The order matches the original MDX editor exactly. Extension order decides
 * precedence in CodeMirror, so a reorder would change keymaps and styling.
 */
export function createBaseExtensions({
  language,
  readOnly,
  onSave,
  onChange,
  ariaLabel,
}: BaseExtensionsOptions): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    search({ top: true }),
    highlightSelectionMatches(),
    language,
    syntaxHighlighting(highlightStyle),
    EditorView.lineWrapping,
    editorTheme,
    readOnly,
    ariaLabel ? EditorView.contentAttributes.of({ "aria-label": ariaLabel }) : [],
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSave()
          return true
        },
      },
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString())
    }),
  ]
}
