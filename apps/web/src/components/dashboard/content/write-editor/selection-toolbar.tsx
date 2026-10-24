import { useRef, useState, type FormEvent, type ReactNode } from "react"
import { posToDOMRect, type Editor } from "@tiptap/core"
import { useEditorState } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"

import { cn } from "~/lib/utils"

/** The dark segmented bar above a text selection: Bold, Italic, Strike, Code, Link, H2. */
export function SelectionToolbar({
  editor,
  appendTo,
}: {
  editor: Editor
  /**
   * Where the bar mounts. It defaults to the editor's parent, which is inside
   * the site canvas, and dashboard chrome must stay outside the canvas.
   */
  appendTo?: () => HTMLElement
}) {
  const [linkDraft, setLinkDraft] = useState<string | null>(null)
  // Where the bar opened for the current selection, relative to the editor,
  // so it scrolls with the page but does not move while it is open.
  const anchorRef = useRef<{ from: number; to: number; left: number; top: number; width: number; height: number } | null>(null)

  /**
   * The selection the bar points at. It is measured once per selection:
   * formatting changes the text's width or size, and the bar must not move
   * when the author clicks Bold or H2.
   */
  function selectionAnchor() {
    const { from, to } = editor.state.selection
    const editorRect = editor.view.dom.getBoundingClientRect()
    let anchor = anchorRef.current
    if (!anchor || anchor.from !== from || anchor.to !== to) {
      const rect = posToDOMRect(editor.view, from, to)
      anchor = {
        from,
        to,
        left: rect.left - editorRect.left,
        top: rect.top - editorRect.top,
        width: rect.width,
        height: rect.height,
      }
      anchorRef.current = anchor
    }
    const rect = new DOMRect(anchor.left + editorRect.left, anchor.top + editorRect.top, anchor.width, anchor.height)
    return { getBoundingClientRect: () => rect, getClientRects: () => [rect] }
  }
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      heading: current.isActive("heading", { level: 2 }),
      href: (current.getAttributes("link").href as string | undefined) ?? "",
    }),
  })

  function applyLink(event: FormEvent) {
    event.preventDefault()
    const href = (linkDraft ?? "").trim()
    const chain = editor.chain().focus().extendMarkRange("link")
    if (href) chain.setLink({ href }).run()
    else chain.unsetLink().run()
    setLinkDraft(null)
  }

  return (
    <BubbleMenu
      editor={editor}
      appendTo={appendTo}
      // At the selection's top left, like every editor menu.
      options={{ placement: "top-start", offset: 8, flip: false }}
      getReferencedVirtualElement={selectionAnchor}
      shouldShow={({ editor: current, state }) =>
        current.isEditable &&
        !state.selection.empty &&
        !current.isActive("codeBlock") &&
        state.selection.$from.parent.isTextblock
      }
      className="surface-menu z-40 flex font-sans"
    >
      {linkDraft !== null ? (
        <form onSubmit={applyLink} className="flex items-center">
          <input
            autoFocus
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setLinkDraft(null)
            }}
            placeholder="https:// or /page"
            aria-label="Link address"
            className="h-8 w-56 bg-transparent px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          <ToolbarButton type="submit" label="Apply link">
            Apply
          </ToolbarButton>
        </form>
      ) : (
        <>
          <ToolbarButton label="Bold" active={active.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <b>B</b>
          </ToolbarButton>
          <ToolbarButton label="Italic" active={active.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <i>I</i>
          </ToolbarButton>
          <ToolbarButton label="Strikethrough" active={active.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <s>S</s>
          </ToolbarButton>
          <ToolbarButton label="Inline code" active={active.code} onClick={() => editor.chain().focus().toggleCode().run()}>
            Code
          </ToolbarButton>
          <ToolbarButton label="Link" active={active.link} onClick={() => setLinkDraft(active.href)}>
            Link
          </ToolbarButton>
          <ToolbarButton
            label="Heading 2"
            active={active.heading}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H2
          </ToolbarButton>
        </>
      )}
    </BubbleMenu>
  )
}

/** One segment of a floating editor bar. */
export function ToolbarButton({
  label,
  active = false,
  onClick,
  type = "button",
  className,
  children,
}: {
  label: string
  active?: boolean
  onClick?: () => void
  type?: "button" | "submit"
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      aria-label={label}
      aria-pressed={type === "button" ? active : undefined}
      title={label}
      className={cn(
        "h-8 border-r border-divider px-2.5 font-mono text-xs font-medium transition-colors last:border-r-0",
        active ? "bg-primary-wash text-primary-text" : "text-body hover:bg-overlay hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}
