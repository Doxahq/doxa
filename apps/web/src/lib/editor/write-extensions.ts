import { Extension, Node, mergeAttributes, wrappingInputRule, type AnyExtension, type NodeViewRenderer } from "@tiptap/core"
import CodeBlock from "@tiptap/extension-code-block"
import { TableCell, TableHeader, TableKit } from "@tiptap/extension-table"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { ContainerKeys } from "~/lib/editor/container-keys"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import StarterKit from "@tiptap/starter-kit"

/** Top-level node types that can carry a `blockId` back to their source text. */
const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "codeBlock",
  "horizontalRule",
  "callout",
  "cardGroup",
  "blockquote",
  "table",
  "steps",
  "tabs",
  "fileTree",
  "mermaid",
  "image",
  "embed",
  "mdxBlock",
]

/** The blocks a step or a tab can hold. */
const CONTAINER_CONTENT =
  "(paragraph | heading | bulletList | orderedList | codeBlock | callout | blockquote | table | cardGroup | steps | tabs | fileTree | mermaid | image | embed)+"

export const EMPTY_BLOCK_PLACEHOLDER = "Type '/' for commands, or just start writing"

/**
 * `blockId` ties a top-level node to its source block. It is not copied when
 * a block splits, so only the original half can keep its original text.
 * `spread` keeps a list tight or loose as it was written.
 */
const BlockIdentity = Extension.create({
  name: "blockIdentity",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: { blockId: { default: null, rendered: false, keepOnSplit: false } },
      },
      {
        types: ["bulletList", "orderedList", "listItem"],
        attributes: { spread: { default: false, rendered: false } },
      },
    ]
  },
})

/** Callout: a `<Note>` in MDX. "> " at the start of a line creates one. */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "(paragraph | heading | bulletList | orderedList | codeBlock | image)+",
  defining: true,
  addAttributes() {
    return { attributes: { default: [], rendered: false } }
  },
  parseHTML() {
    return [{ tag: "div[data-callout]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-callout": "" }), 0]
  },
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*>\s$/, type: this.type })]
  },
})

/**
 * Block quote. It has no "> " shortcut: in Write that makes a callout, and a
 * quote comes from the block menu or from the MDX.
 */
const Blockquote = Node.create({
  name: "blockquote",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML() {
    return [{ tag: "blockquote" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["blockquote", mergeAttributes(HTMLAttributes), 0]
  },
})

/**
 * A GFM table cell holds one line of inline text, so its content is exactly
 * one paragraph. `align` keeps the column alignment for the MDX. The docs
 * renderer does not draw it, so the editor does not either.
 *
 * A GFM table has no column widths. A table pasted from a web page or a
 * document brings its own, and TipTap would fix the table to their sum in
 * pixels, wider than the page. The widths are dropped on paste, so the table
 * sizes to the article as it does on the site.
 */
const tableCellAttributes = {
  align: { default: null, rendered: false },
  colwidth: { default: null, parseHTML: () => null, rendered: false },
}

const GfmTableCell = TableCell.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), ...tableCellAttributes }
  },
})

const GfmTableHeader = TableHeader.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), ...tableCellAttributes }
  },
})

/**
 * Steps: a `<Step>` of `<StepItem>`s. Each item has its title as its first
 * line, typed in place, then its body.
 */
const Steps = Node.create({
  name: "steps",
  group: "block",
  content: "stepItem+",
  defining: true,
  addAttributes() {
    return { attributes: { default: [], rendered: false } }
  },
  parseHTML() {
    return [{ tag: "div[data-steps]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-steps": "" }), 0]
  },
})

const StepItem = Node.create({
  name: "stepItem",
  content: "stepTitle stepBody",
  isolating: true,
  defining: true,
  addAttributes() {
    return {
      attributes: { default: [], rendered: false },
      /** For a one-line `<StepItem>`, the paragraph it shared with its neighbours. */
      line: { default: null, rendered: false },
    }
  },
  parseHTML() {
    return [{ tag: "div[data-step-item]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-step-item": "" }), 0]
  },
})

/** A step's title: the `title` attribute, as the `<h3>` the site draws. */
const StepTitle = Node.create({
  name: "stepTitle",
  content: "text*",
  marks: "",
  defining: true,
  parseHTML() {
    return [{ tag: "h3[data-step-title]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["h3", mergeAttributes(HTMLAttributes, { "data-step-title": "", class: "mt-0!" }), 0]
  },
  addKeyboardShortcuts() {
    return {
      // Enter in a title moves to the step's body instead of splitting it.
      Enter: ({ editor }) => {
        const { $from } = editor.state.selection
        if ($from.parent.type.name !== "stepTitle") return false
        return editor.commands.setTextSelection($from.after() + 2)
      },
    }
  },
})

/** A step's body, the `<div>` the site wraps it in. */
const StepBody = Node.create({
  name: "stepBody",
  content: CONTAINER_CONTENT,
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-step-body]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-step-body": "" }), 0]
  },
})

/**
 * Tabs: a `<Tabs>` with a `<TabsTrigger>` and a `<TabsContent>` per tab. The
 * editor keeps one `tabItem` per tab: its label, its value, and its content.
 */
const Tabs = Node.create({
  name: "tabs",
  group: "block",
  content: "tabItem+",
  defining: true,
  addAttributes() {
    return {
      attributes: { default: [], rendered: false },
      listAttributes: { default: [], rendered: false },
    }
  },
  parseHTML() {
    return [{ tag: "div[data-tabs]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-tabs": "" }), 0]
  },
})

/** One tab's panel, with the markup of the site's `TabsContent`. */
const TabItem = Node.create({
  name: "tabItem",
  content: CONTAINER_CONTENT,
  isolating: true,
  defining: true,
  addAttributes() {
    return {
      label: { default: "", rendered: false },
      value: { default: "", rendered: false },
      triggerAttributes: { default: [], rendered: false },
      contentAttributes: { default: [], rendered: false },
      /** For a one-line `<TabsContent>`, the paragraph it shared with its neighbours. */
      line: { default: null, rendered: false },
    }
  },
  parseHTML() {
    return [{ tag: "div[data-tab-item]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-tab-item": "",
        "data-slot": "tabs-content",
        role: "tabpanel",
        class: "flex-1 outline-none",
      }),
      0,
    ]
  },
})

/** A `<FileTree>`: its folders and files as data, edited as an outline. */
const FileTree = Node.create({
  name: "fileTree",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      attributes: { default: [], rendered: false },
      items: { default: [], rendered: false },
    }
  },
  parseHTML() {
    return [{ tag: "div[data-file-tree]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-file-tree": "" })]
  },
})

/** A `<Mermaid>` diagram: its chart text and its other attributes. */
const Mermaid = Node.create({
  name: "mermaid",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      chart: { default: "", rendered: false },
      attributes: { default: [], rendered: false },
    }
  },
  parseHTML() {
    return [{ tag: "div[data-mermaid]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-mermaid": "" })]
  },
})

/** Card group: a `<CardGrid>` of `<Card>`s, edited in its own view. */
const CardGroup = Node.create({
  name: "cardGroup",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      attributes: { default: [], rendered: false },
      cards: { default: [], rendered: false },
      /** False for cards written on their own, without a `<CardGrid>`. */
      grid: { default: true, rendered: false },
    }
  },
  parseHTML() {
    return [{ tag: "div[data-card-group]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-card-group": "" })]
  },
})

/**
 * An image on its own line: `![alt](src "title")` in MDX. `uploadId` marks an
 * image whose upload has not finished. It has no `src` yet and is not saved.
 *
 * Images in HTML pasted from other sites are not read: a page would hotlink
 * them. Copying an image inside the editor keeps it.
 */
const Image = Node.create({
  name: "image",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: "", rendered: false },
      alt: { default: "", rendered: false },
      title: { default: null, rendered: false },
      uploadId: { default: null, rendered: false, keepOnSplit: false },
    }
  },
  parseHTML() {
    return [
      {
        tag: "figure[data-doxa-image]",
        getAttrs: (element) => ({
          src: element.getAttribute("data-src") ?? "",
          alt: element.getAttribute("data-alt") ?? "",
          title: element.getAttribute("data-title"),
        }),
      },
    ]
  },
  renderHTML({ node }) {
    return [
      "figure",
      {
        "data-doxa-image": "",
        "data-src": node.attrs.src,
        "data-alt": node.attrs.alt,
        ...(node.attrs.title ? { "data-title": node.attrs.title } : {}),
      },
    ]
  },
})

/** A video: `<Embed url="…" />` for YouTube, Vimeo and Loom. */
const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { attributes: { default: [], rendered: false } }
  },
  parseHTML() {
    return [{ tag: "div[data-embed]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-embed": "" })]
  },
})

/** A block the editor cannot model. It keeps its MDX source as it is. */
const MdxBlock = Node.create({
  name: "mdxBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { source: { default: "", rendered: false } }
  },
  parseHTML() {
    return [{ tag: "div[data-mdx-block]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-mdx-block": "" })]
  },
})

/** Fenced code keeps its info string after the language (`title="app.ts"`). */
const CodeBlockWithMeta = CodeBlock.extend({
  addAttributes() {
    return { ...this.parent?.(), meta: { default: null, rendered: false } }
  },
})

/** The hint for an empty line of each kind. Other kinds show none. */
const PLACEHOLDERS: Record<string, string> = {
  paragraph: EMPTY_BLOCK_PLACEHOLDER,
  stepTitle: "Step title",
}

/** Lines inside these hold one short value, where the block hint is noise. */
const NO_HINT_PARENTS = new Set(["tableCell", "tableHeader"])

/**
 * The hint on the empty line that holds the cursor, at any depth: a top-level
 * line, a line in a note, a step or a tab, or a step's title.
 *
 * TipTap's placeholder reaches nested lines only in its incremental mode, which
 * leaves the hint behind on the lines the cursor passes with the arrow keys.
 * This plugin draws one decoration from the selection on every state, so a
 * line loses the hint as soon as the cursor leaves it.
 */
const CurrentLinePlaceholder = Extension.create({
  name: "currentLinePlaceholder",
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey("currentLinePlaceholder"),
        props: {
          decorations: ({ doc, selection }) => {
            if (!editor.isEditable || !selection.empty) return null
            const { $from } = selection
            const line = $from.parent
            const hint = PLACEHOLDERS[line.type.name]
            if (!hint || line.content.size > 0 || $from.depth < 1) return null
            if ($from.depth > 1 && NO_HINT_PARENTS.has($from.node(-1).type.name)) return null
            const start = $from.before()
            return DecorationSet.create(doc, [
              Decoration.node(start, start + line.nodeSize, { class: "is-empty", "data-placeholder": hint }),
            ])
          },
        },
      }),
    ]
  },
})

export interface WriteNodeViews {
  codeBlock?: NodeViewRenderer
  callout?: NodeViewRenderer
  cardGroup?: NodeViewRenderer
  mdxBlock?: NodeViewRenderer
  steps?: NodeViewRenderer
  stepItem?: NodeViewRenderer
  tabs?: NodeViewRenderer
  fileTree?: NodeViewRenderer
  mermaid?: NodeViewRenderer
  image?: NodeViewRenderer
  embed?: NodeViewRenderer
}

function withView(node: Node, view: NodeViewRenderer | undefined): Node {
  return view ? node.extend({ addNodeView: () => view }) : node
}

/**
 * The Write editor schema. Node views are passed in, so tests can build the
 * same schema without React.
 */
export function createWriteExtensions(views: WriteNodeViews = {}, extra: AnyExtension[] = []): AnyExtension[] {
  return [
    StarterKit.configure({
      // Markdown has no underline, and "> " makes a callout instead.
      underline: false,
      blockquote: false,
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { target: null, rel: null } },
      dropcursor: { color: "var(--dashboard-primary)", width: 2 },
    }),
    BlockIdentity,
    views.codeBlock ? CodeBlockWithMeta.extend({ addNodeView: () => views.codeBlock! }) : CodeBlockWithMeta,
    withView(Callout, views.callout),
    withView(CardGroup, views.cardGroup),
    withView(MdxBlock, views.mdxBlock),
    withView(Steps, views.steps),
    withView(StepItem, views.stepItem),
    StepTitle,
    StepBody,
    withView(Tabs, views.tabs),
    TabItem,
    withView(FileTree, views.fileTree),
    withView(Mermaid, views.mermaid),
    withView(Image, views.image),
    withView(Embed, views.embed),
    Blockquote,
    TableKit.configure({
      table: { resizable: false, allowTableNodeSelection: true },
      tableCell: false,
      tableHeader: false,
    }),
    GfmTableCell,
    GfmTableHeader,
    CurrentLinePlaceholder,
    ContainerKeys,
    ...extra,
  ]
}
