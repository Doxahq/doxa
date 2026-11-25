import { syntaxHighlighting } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, lineNumbers } from "@codemirror/view"

import { editorTheme, highlightStyle } from "~/components/code-editor/editor-theme"
import { mdxEditorExtensions } from "~/components/code-editor/languages/mdx"

const REMOVED = "var(--destructive)"
const ADDED = "var(--success)"

/**
 * The diff colors from the dashboard tokens: red for the old source, green
 * for the new one. The side-by-side view marks its editors `cm-merge-a` and
 * `cm-merge-b`; the unified view shows the old lines as deleted chunks.
 */
const diffTheme = EditorView.theme(
  {
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
      backgroundColor: `color-mix(in oklch, ${REMOVED} 12%, transparent)`,
    },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine, &:not(.cm-merge-a):not(.cm-merge-b) .cm-changedLine": {
      backgroundColor: `color-mix(in oklch, ${ADDED} 10%, transparent)`,
    },
    "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
      background: `color-mix(in oklch, ${REMOVED} 30%, transparent)`,
    },
    "&.cm-merge-b .cm-changedText, &:not(.cm-merge-a):not(.cm-merge-b) .cm-changedText": {
      background: `color-mix(in oklch, ${ADDED} 25%, transparent)`,
    },
    "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: REMOVED },
    "&.cm-merge-b .cm-changedLineGutter, &:not(.cm-merge-a):not(.cm-merge-b) .cm-changedLineGutter": {
      background: ADDED,
    },
    ".cm-deletedChunk": { paddingLeft: "6px" },
    ".cm-collapsedLines": {
      color: "var(--muted-foreground)",
      background: "var(--card)",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
    },
  },
)

/** A read-only MDX editor with the dashboard theme and the diff colors. */
export const READ_ONLY_DIFF_EXTENSIONS: Extension[] = [
  lineNumbers(),
  mdxEditorExtensions,
  syntaxHighlighting(highlightStyle),
  EditorView.lineWrapping,
  editorTheme,
  diffTheme,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
]

/** Names an editor for screen readers. */
export function labelled(label: string): Extension {
  return EditorView.contentAttributes.of({ "aria-label": label })
}

/** Long unchanged stretches collapse to one line; a click expands them. */
export const COLLAPSE_UNCHANGED = { margin: 3, minSize: 6 } as const
