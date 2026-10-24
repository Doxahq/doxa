import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { Prec, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { styleTags, Tag, tags } from "@lezer/highlight"

/**
 * Inline code gets its own tag. Markdown tags inline code and fenced code text
 * both as `monospace`, and a chip background only reads well on inline spans.
 */
const inlineCode = Tag.define(tags.monospace)

/** A module constant, so the editor never reconfigures its language. */
export const mdxLanguage: Extension = markdown({
  base: markdownLanguage,
  extensions: [{ props: [styleTags({ InlineCode: inlineCode })] }],
})

/**
 * The MDX source view. Page source is mostly prose, so it gets more line
 * height than code, and lines wrap at the pane width. The rich Write editor
 * is the long-form writing surface.
 *
 * The theme has the highest precedence, so it wins over the shared editor
 * theme, which comes later in the extension list.
 */
const mdxWritingTheme = Prec.highest(
  EditorView.theme({
    "&": {
      color: "var(--prose)",
      backgroundColor: "var(--editor)",
      fontSize: "13.5px",
    },
    ".cm-scroller": { lineHeight: "1.75" },
    ".cm-content": { padding: "16px 0" },
    ".cm-line": { padding: "0 16px 0 12px" },
    ".cm-gutters": { fontSize: "12px" },
  }),
)

const mdxHighlightStyle = HighlightStyle.define([
  {
    tag: inlineCode,
    color: "var(--success)",
    backgroundColor: "var(--code)",
    outline: "1px solid var(--divider)",
  },
])

/** Everything the page source editor adds on top of the shared editor setup. */
export const mdxEditorExtensions: Extension = [
  mdxLanguage,
  mdxWritingTheme,
  syntaxHighlighting(mdxHighlightStyle),
]
