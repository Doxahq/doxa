import { useRef, useState } from "react"
import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import DragHandle from "@tiptap/extension-drag-handle-react"
import { Copy, GripVertical, Heading2, Heading3, List, ListOrdered, Plus, Trash2, Type } from "lucide-react"

import { MoreMenuLabel } from "~/components/dashboard/shell/top-bar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"

interface GutterTarget {
  node: ProseMirrorNode
  pos: number
}

/** Parts of a component that move with it and are never dragged on their own. */
const NOT_DRAGGABLE = new Set(["stepTitle", "stepBody", "tabItem"])

/**
 * Blocks inside a note, a step or a tab get the gutter too, so they can be
 * moved within and out of their component. A step is dragged as a whole
 * step, a tab set as a whole. The lines of a table cell never are.
 */
const NESTED_DRAG = {
  rules: [
    {
      id: "componentParts",
      evaluate: ({ node }: { node: ProseMirrorNode }) => (NOT_DRAGGABLE.has(node.type.name) ? 1000 : 0),
    },
    {
      id: "tableCellLines",
      evaluate: ({ parent }: { parent: ProseMirrorNode | null }) =>
        parent && (parent.type.name === "tableCell" || parent.type.name === "tableHeader") ? 1000 : 0,
    },
  ],
}

const TURN_INTO = [
  { label: "Text", icon: Type, run: (editor: Editor) => editor.chain().focus().setParagraph().run() },
  { label: "Heading 2", icon: Heading2, run: (editor: Editor) => editor.chain().focus().setNode("heading", { level: 2 }).run() },
  { label: "Heading 3", icon: Heading3, run: (editor: Editor) => editor.chain().focus().setNode("heading", { level: 3 }).run() },
  { label: "Bulleted list", icon: List, run: (editor: Editor) => editor.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", icon: ListOrdered, run: (editor: Editor) => editor.chain().focus().toggleOrderedList().run() },
]

/**
 * The hover gutter left of each block: "+" adds a block below and opens the
 * block menu; the grip drags the block, and a click on it opens block actions.
 */
export function BlockGutter({ editor }: { editor: Editor }) {
  const [target, setTarget] = useState<GutterTarget | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The plugin can keep the first callback it receives, so the flag lives in a ref.
  const menuOpenRef = useRef(false)
  menuOpenRef.current = menuOpen

  function addBelow() {
    if (!target) return
    const at = target.pos + target.node.nodeSize
    editor.chain().insertContentAt(at, { type: "paragraph" }).setTextSelection(at + 1).insertContent("/").focus().run()
  }

  function duplicate() {
    if (!target) return
    const copy = target.node.toJSON() as { attrs?: Record<string, unknown> }
    // A copy is a new block. It must not claim the original's source text.
    if (copy.attrs) copy.attrs = { ...copy.attrs, blockId: null }
    editor.chain().insertContentAt(target.pos + target.node.nodeSize, copy).focus().run()
  }

  function remove() {
    if (!target) return
    editor.chain().deleteRange({ from: target.pos, to: target.pos + target.node.nodeSize }).focus().run()
  }

  function turnInto(run: (editor: Editor) => boolean) {
    if (!target) return
    editor.chain().setTextSelection(target.pos + 1).run()
    run(editor)
  }

  const canTurnInto = target?.node.isTextblock ?? false

  return (
    <DragHandle
      editor={editor}
      nested={NESTED_DRAG}
      onNodeChange={({ node, pos }) => {
        // Keep the target while the block menu is open, so its actions apply to the right block.
        if (!menuOpenRef.current) setTarget(node ? { node, pos } : null)
      }}
      className="doxa-gutter"
    >
      <div className="flex items-center gap-0.5 pr-1.5">
        <button
          type="button"
          onClick={addBelow}
          aria-label="Add a block below"
          title="Add a block below"
          className="grid h-[26px] w-6 place-items-center text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Drag to move, click for block actions"
              title="Drag to move, click for actions"
              className="grid h-[26px] w-6 cursor-grab place-items-center text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="left" align="start" className="w-52 p-1.5">
            {canTurnInto ? (
              <>
                <MoreMenuLabel>Turn into</MoreMenuLabel>
                {TURN_INTO.map(({ label, icon: Icon, run }) => (
                  <DropdownMenuItem key={label} onSelect={() => turnInto(run)}>
                    <Icon />
                    {label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator className="my-1.5 bg-divider" />
              </>
            ) : null}
            <DropdownMenuItem onSelect={duplicate}>
              <Copy />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={remove} className="text-danger focus:text-danger [&_svg]:text-danger">
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </DragHandle>
  )
}
