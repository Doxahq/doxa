import { HighlightStyle } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags } from "@lezer/highlight"

/**
 * CodeMirror 6 is used instead of a full web IDE. It loads in a fraction of the
 * bytes, mounts without a worker, and takes its colors from the dashboard
 * tokens, so the editor matches the rest of the shell instead of shipping a
 * second theme.
 */
export const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--foreground)",
      backgroundColor: "transparent",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.7",
      overflow: "auto",
    },
    ".cm-content": { padding: "12px 0", caretColor: "var(--primary)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
      border: "none",
      borderRight: "1px solid var(--border)",
      paddingRight: "8px",
    },
    ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 45%, transparent)" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--foreground)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--selection)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)",
    },
    ".cm-panels": {
      backgroundColor: "var(--card)",
      color: "var(--foreground)",
      border: "1px solid var(--border)",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
    },
    ".cm-textfield": {
      backgroundColor: "var(--background)",
      border: "1px solid var(--border)",
      color: "var(--foreground)",
    },
    ".cm-button": {
      backgroundColor: "var(--secondary)",
      backgroundImage: "none",
      border: "1px solid var(--border)",
      color: "var(--foreground)",
    },
  },
  { dark: true },
)

export const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--foreground)", fontWeight: "700" },
  { tag: tags.strong, color: "var(--foreground)", fontWeight: "700" },
  { tag: tags.emphasis, color: "var(--foreground)", fontStyle: "italic" },
  { tag: tags.link, color: "var(--primary)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--primary)" },
  { tag: tags.monospace, color: "var(--success)" },
  { tag: tags.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--primary)" },
  { tag: tags.meta, color: "var(--muted-foreground)" },
  { tag: tags.processingInstruction, color: "var(--muted-foreground)" },
  { tag: tags.contentSeparator, color: "var(--muted-foreground)" },
  { tag: tags.tagName, color: "var(--warning)" },
  { tag: tags.attributeName, color: "var(--primary)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
])
