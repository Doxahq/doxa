import { Extension, type JSONContent } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"

import { parseMdxDocument } from "~/lib/editor/mdx-document"

/**
 * Pasting Markdown or MDX text makes real blocks: a heading, a list, a note,
 * tabs, a table. Text copied from the MDX editor, a README or another page
 * arrives as plain text, and without this it would land as one paragraph per
 * line with the syntax showing.
 *
 * Only text with clear Markdown or MDX syntax is converted. Other text, and
 * any paste into a code block, keeps the default behavior.
 */

const BLOCK_SIGNALS = [
  /^#{1,6}\s+\S/m, // heading
  /^```/m, // code fence
  /^\s*[-*+]\s+\S/m, // bulleted list
  /^\s*\d+[.)]\s+\S/m, // numbered list
  /^>\s?\S/m, // quote
  /^\|.*\|\s*$\n^\|?\s*:?-{3,}/m, // table header and delimiter row
  /<(Note|CardGrid|Card|Step|StepItem|Tabs|TabsList|TabsTrigger|TabsContent|FileTree|Folder|File|Mermaid|Api[A-Z]\w*)\b/,
]

const INLINE_SIGNALS = [/\*\*[^*\n]+\*\*/, /\[[^\]\n]+\]\([^)\s]+\)/, /`[^`\n]+`/, /(^|\s)_[^_\n]+_(\s|$)/]

/** Whether pasted text is written in Markdown or MDX, and not just prose. */
export function looksLikeMdx(text: string): boolean {
  return [...BLOCK_SIGNALS, ...INLINE_SIGNALS].some((signal) => signal.test(text))
}

/**
 * The editor content for pasted MDX, or null to paste it as text. Pasted
 * blocks are new: they carry no `blockId`, so none of them can claim the
 * source text of a block that is already on the page.
 */
export function pastedContent(text: string): { inline: JSONContent[] } | { blocks: JSONContent[] } | null {
  if (!looksLikeMdx(text)) return null
  const blocks = (parseMdxDocument(text.replace(/\r\n/g, "\n")).content.content ?? []).map(({ attrs, ...node }) => {
    const { blockId: _blockId, ...rest } = attrs ?? {}
    return Object.keys(rest).length > 0 ? { ...node, attrs: rest } : node
  })
  if (blocks.length === 0) return null
  // Text the parser could not read becomes one locked block. Plain text is better.
  if (blocks.length === 1 && blocks[0].type === "mdxBlock") return null
  if (blocks.length === 1 && blocks[0].type === "paragraph") {
    return blocks[0].content?.length ? { inline: blocks[0].content } : null
  }
  return { blocks }
}

export const MdxPaste = Extension.create({
  name: "mdxPaste",
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey("mdxPaste"),
        props: {
          handlePaste: (view, event) => {
            if (!editor.isEditable) return false
            const { $from } = view.state.selection
            if ($from.parent.type.spec.code) return false
            const text = event.clipboardData?.getData("text/plain")
            if (!text) return false
            const content = pastedContent(text)
            if (!content) return false
            event.preventDefault()
            if ("inline" in content) return editor.commands.insertContent(content.inline)
            // Blocks pasted on an empty line take its place.
            if ($from.parent.type.name === "paragraph" && $from.parent.content.size === 0) {
              return editor.commands.insertContentAt({ from: $from.before(), to: $from.after() }, content.blocks)
            }
            return editor.commands.insertContent(content.blocks)
          },
        },
      }),
    ]
  },
})
