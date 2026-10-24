import { Fragment, useEffect, useRef, useSyncExternalStore, type ComponentType } from "react"
import { Extension, type Editor, type Range } from "@tiptap/core"
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion"
import {
  CircleAlert,
  CircleCheck,
  Code2,
  FolderTree,
  GitFork,
  Heading2,
  Heading3,
  ImageIcon,
  Info,
  LayoutGrid,
  List,
  ListOrdered,
  ListChecks,
  Minus,
  Quote,
  PanelTop,
  PlayCircle,
  RectangleHorizontal,
  Table,
  TriangleAlert,
  Type,
} from "lucide-react"

import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { canUploadImages } from "~/lib/editor/image-upload"
import type { MdxAttribute } from "~/lib/editor/mdx-document"
import { cn } from "~/lib/utils"

export type BlockCommandGroup = "basic" | "media" | "components"

const GROUP_LABELS: Record<BlockCommandGroup, string> = {
  basic: "Basic blocks",
  media: "Media",
  components: "Components",
}

export interface BlockCommand {
  id: string
  group: BlockCommandGroup
  /** The node type the command puts where the "/" line is. */
  node: string
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
  /** The markdown shortcut that makes the same block. */
  hint?: string
  /** False hides the command, for example image upload without a branch. */
  available?: (editor: Editor) => boolean
  run: (editor: Editor, range: Range) => void
}

/** A `<Note>` of one type, with the matching title. */
function insertNote(attributes: MdxAttribute[]) {
  return (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range).wrapIn("callout", { attributes }).run()
}

/**
 * Every block Write can edit. Basic blocks are Markdown; media are images
 * uploaded to the branch and video embeds; components are the docs
 * components the site renders.
 */
export const BLOCK_COMMANDS: BlockCommand[] = [
  {
    id: "text",
    node: "paragraph",
    group: "basic",
    label: "Text",
    description: "Plain paragraph",
    icon: Type,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    id: "heading-2",
    node: "heading",
    group: "basic",
    label: "Heading 2",
    description: "Section heading",
    icon: Heading2,
    hint: "##",
    run: (editor, range) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "heading-3",
    node: "heading",
    group: "basic",
    label: "Heading 3",
    description: "Sub-section heading",
    icon: Heading3,
    hint: "###",
    run: (editor, range) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
  },
  {
    id: "bulleted-list",
    node: "bulletList",
    group: "basic",
    label: "Bulleted list",
    description: "Simple list",
    icon: List,
    hint: "-",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    node: "orderedList",
    group: "basic",
    label: "Numbered list",
    description: "Ordered steps",
    icon: ListOrdered,
    hint: "1.",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: "quote",
    node: "blockquote",
    group: "basic",
    label: "Quote",
    description: "Quoted text",
    icon: Quote,
    run: (editor, range) => editor.chain().focus().deleteRange(range).wrapIn("blockquote").run(),
  },
  {
    id: "code-block",
    node: "codeBlock",
    group: "basic",
    label: "Code block",
    description: "Code snippet with a language",
    icon: Code2,
    hint: "```",
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCodeBlock().run(),
  },
  {
    id: "divider",
    node: "horizontalRule",
    group: "basic",
    label: "Divider",
    description: "Visual separator",
    icon: Minus,
    hint: "---",
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    id: "image",
    node: "image",
    group: "media",
    label: "Image",
    description: "Upload a PNG, JPEG, WebP, GIF or SVG",
    icon: ImageIcon,
    available: canUploadImages,
    // An empty image waits for a file. It is not saved until it has one.
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertContent({ type: "image", attrs: { src: "" } }).run(),
  },
  {
    id: "embed",
    node: "embed",
    group: "media",
    label: "Video embed",
    description: "YouTube, Vimeo or Loom video",
    icon: PlayCircle,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertContent({ type: "embed", attrs: { attributes: [] } }).run(),
  },
  {
    id: "note",
    node: "callout",
    group: "components",
    label: "Note",
    description: "Highlight a note or tip",
    icon: Info,
    hint: ">",
    run: insertNote([]),
  },
  {
    id: "note-success",
    node: "callout",
    group: "components",
    label: "Success note",
    description: "Confirm that something worked",
    icon: CircleCheck,
    run: insertNote([
      { name: "title", value: "Success" },
      { name: "type", value: "success" },
    ]),
  },
  {
    id: "note-warning",
    node: "callout",
    group: "components",
    label: "Warning note",
    description: "Warn about a risk",
    icon: TriangleAlert,
    run: insertNote([
      { name: "title", value: "Warning" },
      { name: "type", value: "warning" },
    ]),
  },
  {
    id: "note-danger",
    node: "callout",
    group: "components",
    label: "Danger note",
    description: "Stop the reader before damage",
    icon: CircleAlert,
    run: insertNote([
      { name: "title", value: "Danger" },
      { name: "type", value: "danger" },
    ]),
  },
  {
    id: "card-group",
    node: "cardGroup",
    group: "components",
    label: "Card group",
    description: "Grid of linked cards",
    icon: LayoutGrid,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "cardGroup",
          attrs: {
            attributes: [],
            cards: [{ attributes: [{ name: "title", value: "Card title" }], body: "Describe this card." }],
          },
        })
        .run(),
  },
  {
    id: "card",
    node: "cardGroup",
    group: "components",
    label: "Card",
    description: "One full-width linked card",
    icon: RectangleHorizontal,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "cardGroup",
          // Written as a lone `<Card>`, without a `<CardGrid>` around it.
          attrs: { attributes: [], grid: false, cards: [{ attributes: [{ name: "title", value: "Card title" }], body: "Describe this card." }] },
        })
        .run(),
  },
  {
    id: "steps",
    node: "steps",
    group: "components",
    label: "Steps",
    description: "Numbered steps with titles",
    icon: ListChecks,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "steps",
          content: [1, 2].map(() => ({
            type: "stepItem",
            content: [{ type: "stepTitle" }, { type: "stepBody", content: [{ type: "paragraph" }] }],
          })),
        })
        .run(),
  },
  {
    id: "tabs",
    node: "tabs",
    group: "components",
    label: "Tabs",
    description: "Alternatives side by side",
    icon: PanelTop,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "tabs",
          content: ["npm", "pnpm"].map((label) => ({
            type: "tabItem",
            attrs: { label, value: label },
            content: [{ type: "paragraph" }],
          })),
        })
        .run(),
  },
  {
    id: "file-tree",
    node: "fileTree",
    group: "components",
    label: "File tree",
    description: "Folders and files of a project",
    icon: FolderTree,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "fileTree",
          attrs: {
            items: [
              {
                kind: "folder",
                attributes: [
                  { name: "name", value: "src" },
                  { name: "defaultOpen", value: null },
                ],
                children: [{ kind: "file", attributes: [{ name: "name", value: "index.ts" }] }],
              },
              { kind: "file", attributes: [{ name: "name", value: "package.json" }] },
            ],
          },
        })
        .run(),
  },
  {
    id: "diagram",
    node: "mermaid",
    group: "components",
    label: "Diagram",
    description: "Mermaid flowchart or sequence",
    icon: GitFork,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: "mermaid", attrs: { chart: "flowchart LR\n  A[Start] --> B[Finish]" } })
        .run(),
  },
  {
    id: "table",
    node: "table",
    group: "components",
    label: "Table",
    description: "Rows and columns with a header",
    icon: Table,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
]

interface SlashMenuState {
  open: boolean
  items: BlockCommand[]
  index: number
  rect: DOMRect | null
  select: ((item: BlockCommand) => void) | null
}

const CLOSED: SlashMenuState = { open: false, items: [], index: 0, rect: null, select: null }

/** Bridges the suggestion plugin to the React menu. One store per editor. */
export class SlashMenuStore {
  private state: SlashMenuState = CLOSED
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.state

  private set(next: SlashMenuState) {
    this.state = next
    this.listeners.forEach((listener) => listener())
  }

  show(props: SuggestionProps<BlockCommand, BlockCommand>) {
    this.set({
      open: props.items.length > 0,
      items: props.items,
      index: Math.min(this.state.open ? this.state.index : 0, Math.max(0, props.items.length - 1)),
      rect: props.clientRect?.() ?? null,
      select: (item) => props.command(item),
    })
  }

  close() {
    this.set(CLOSED)
  }

  choose(index: number) {
    const item = this.state.items[index]
    if (item) this.state.select?.(item)
  }

  /** Arrow keys move, Enter picks, Esc closes. True when the key was used. */
  keyDown(event: KeyboardEvent): boolean {
    if (!this.state.open) return false
    const count = this.state.items.length
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1
      this.set({ ...this.state, index: (this.state.index + step + count) % count })
      return true
    }
    if (event.key === "Enter") {
      this.choose(this.state.index)
      return true
    }
    if (event.key === "Escape") {
      this.close()
      return true
    }
    return false
  }
}

/**
 * Whether a block of `type` can take the place of the line with the cursor.
 * A note holds no divider or table, and a table cell holds only text, so the
 * menu leaves out what the container would refuse.
 */
export function fitsHere(editor: Editor, type: string): boolean {
  const nodeType = editor.schema.nodes[type]
  const { $from } = editor.state.selection
  if (!nodeType || $from.depth < 1) return false
  const container = $from.node(-1)
  const index = $from.index(-1)
  return container.canReplaceWith(index, index + 1, nodeType)
}

/** "/" in a paragraph opens the block menu. */
export function createSlashCommand(store: SlashMenuStore) {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion<BlockCommand, BlockCommand>({
          editor: this.editor,
          char: "/",
          allowSpaces: false,
          allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name === "paragraph",
          items: ({ query, editor }) => {
            const term = query.trim().toLowerCase()
            return BLOCK_COMMANDS.filter(
              (command) =>
                fitsHere(editor, command.node) &&
                (command.available?.(editor) ?? true) &&
                (!term ||
                  command.label.toLowerCase().includes(term) ||
                  command.description.toLowerCase().includes(term)),
            )
          },
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => ({
            onStart: (props) => store.show(props),
            onUpdate: (props) => store.show(props),
            onKeyDown: ({ event }) => store.keyDown(event),
            onExit: () => store.close(),
          }),
        }),
      ]
    },
  })
}

/** Room the slash menu keeps from the caret, and from the top of the window. */
const MENU_GAP = 6
const MENU_MAX_HEIGHT = 320
const MENU_MIN_HEIGHT = 160

/**
 * The floating block menu. Like every editor menu, it sits above where the
 * author works, starting at its left edge: here, above the caret. Its bottom
 * stays put while the list filters. With little room above, it gets shorter
 * and scrolls. Only when even a short menu does not fit above, near the top
 * of the window, does it open under the line.
 */
export function SlashMenu({ store }: { store: SlashMenuStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${state.index}"]`)?.scrollIntoView({ block: "nearest" })
  }, [state.index])

  if (!state.open || !state.rect) return null
  const room = state.rect.top - MENU_GAP - 8
  const above = room >= MENU_MIN_HEIGHT
  const position = above
    ? { bottom: window.innerHeight - state.rect.top + MENU_GAP, maxHeight: Math.min(MENU_MAX_HEIGHT, room) }
    : { top: state.rect.bottom + MENU_GAP, maxHeight: MENU_MAX_HEIGHT }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Insert a block"
      className="surface-menu fixed z-50 w-[280px] overflow-y-auto p-1.5 font-sans scrollbar-subtle"
      style={{ ...position, left: state.rect.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {state.items.map((item, index) => {
        const Icon = item.icon
        const selected = index === state.index
        const startsGroup = index === 0 || state.items[index - 1].group !== item.group
        return (
          <Fragment key={item.id}>
            {startsGroup ? (
              <div className={cn("px-2.5 pb-1.5", index === 0 ? "pt-1.5" : "pt-3")}>
                <MenuSectionLabel>{GROUP_LABELS[item.group]}</MenuSectionLabel>
              </div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={selected}
              data-index={index}
              onClick={() => store.choose(index)}
              className={cn(
                "flex w-full items-center gap-3 px-2.5 py-2 text-left text-[13.5px] text-foreground",
                selected ? "bg-primary-wash" : "hover:bg-overlay",
              )}
            >
              <span
                className={cn(
                  "grid size-[30px] shrink-0 place-items-center rounded-md border bg-background",
                  selected ? "border-primary/40 text-primary-text" : "border-border text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{item.label}</span>
                <span className="block text-xs text-muted-foreground">{item.description}</span>
              </span>
              {item.hint ? <span className="font-mono text-[11px] text-label">{item.hint}</span> : null}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
