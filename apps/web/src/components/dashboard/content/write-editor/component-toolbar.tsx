import { useEffect, useRef, useState, type ReactNode } from "react"
import { resolveEmbedUrl } from "@doxahq/mdx-runtime"
import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { NodeSelection, TextSelection, type EditorState } from "@tiptap/pm/state"
import { useEditorState } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { ImageUp, Trash2 } from "lucide-react"

import { LazyCodeEditor, preloadCodeEditor } from "~/components/code-editor/lazy-code-editor"
import { Select, TextArea, TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import { EmbedLinkField, ImageDropzone } from "~/components/dashboard/content/write-editor/media-views"
import { ToolbarButton } from "~/components/dashboard/content/write-editor/selection-toolbar"
import { EMBED_URL_PROP, NOTE_PROPS, readProp, writeProp, type PropField } from "~/lib/editor/component-props"
import { formatOutline, parseOutline } from "~/lib/editor/file-tree-outline"
import { canUploadImages, uploadIntoImage } from "~/lib/editor/image-upload"
import type { FileTreeItem, MdxAttribute } from "~/lib/editor/mdx-document"

const PLUGIN_KEY = "componentToolbar"

/** The bar's name for each component it serves. */
const COMPONENT_LABELS: Record<string, string> = {
  callout: "Note",
  table: "Table",
  steps: "Steps",
  tabs: "Tabs",
  fileTree: "File tree",
  mermaid: "Diagram",
  image: "Image",
  embed: "Video",
}

/** Components with a source panel that the bar can open. */
const PANEL_TYPES = new Set(["fileTree", "mermaid"])

/**
 * True for an image or video that the bar can edit: one with its file or
 * link. An empty one has its own controls in the page, and an image that
 * is uploading cannot change until the upload ends.
 */
function isEditableMedia(node: ProseMirrorNode): boolean {
  if (node.type.name === "image") return Boolean(node.attrs.src) && !node.attrs.uploadId
  if (node.type.name === "embed") {
    return Boolean(resolveEmbedUrl(String(readProp((node.attrs.attributes ?? []) as MdxAttribute[], EMBED_URL_PROP))))
  }
  return true
}

/** Mermaid has no CodeMirror grammar here. The editor shows it as plain text. */
interface ComponentTarget {
  node: ProseMirrorNode
  pos: number
}

/** The components around the selection, from the outermost to the innermost. */
function findComponents(state: EditorState): ComponentTarget[] {
  const found: ComponentTarget[] = []
  const { selection } = state
  const { $from } = selection
  for (let depth = 1; depth <= $from.depth; depth += 1) {
    const node = $from.node(depth)
    if (node.type.name in COMPONENT_LABELS) found.push({ node, pos: $from.before(depth) })
  }
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name in COMPONENT_LABELS &&
    isEditableMedia(selection.node)
  ) {
    found.push({ node: selection.node, pos: selection.from })
  }
  return found
}

/**
 * The component the bar serves: the one picked in its path, while the cursor
 * is still inside it, or else the innermost.
 */
function findComponent(state: EditorState, picked: number | null = null): ComponentTarget | null {
  const chain = findComponents(state)
  return chain.find((component) => component.pos === picked) ?? chain.at(-1) ?? null
}

/**
 * The child of a container that holds the cursor: a step of a `steps` block,
 * a tab of a `tabs` block. Null when the cursor is not inside one.
 */
function childAtCursor(state: EditorState, containerPos: number): { index: number; pos: number; node: ProseMirrorNode } | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.before(depth) === containerPos && depth < $from.depth) {
      return { index: $from.index(depth), pos: $from.before(depth + 1), node: $from.node(depth + 1) }
    }
  }
  return null
}

/**
 * The bar at the top left of the component the cursor is in, where every
 * editor menu sits: a note's type and title, a table's rows and columns, the
 * steps and tabs, an image's file and alt text, a video's link, and the
 * source of a file tree or a diagram. It mounts outside the site canvas, so
 * it keeps the dashboard look. It stays out of the way of a text selection,
 * which has its own bar.
 */
export function ComponentToolbar({ editor, appendTo }: { editor: Editor; appendTo: () => HTMLElement }) {
  // A component picked in the bar's path, such as the tab set around a table.
  // It is read by the plugin callbacks too, so it lives in a ref as well.
  const [picked, setPicked] = useState<number | null>(null)
  const pickedRef = useRef<number | null>(null)
  pickedRef.current = picked

  const around = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const chain = findComponents(current.state).map((component) => ({ type: component.node.type.name, pos: component.pos }))
      const found = findComponent(current.state, picked)
      return {
        chain,
        target: found ? { type: found.node.type.name, pos: found.pos, attrs: found.node.attrs } : null,
      }
    },
    equalityFn: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  })
  const target = around.target
  const innermost = around.chain.at(-1)?.pos ?? null

  // Moving into another component forgets the pick.
  useEffect(() => {
    setPicked(null)
  }, [innermost])

  useEffect(() => {
    // The bar now points at another block, so it moves.
    editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, "updatePosition"))
  }, [editor, target?.pos])

  // The source panel belongs to one block. Moving to another block closes it.
  const [panelFor, setPanelFor] = useState<number | null>(null)
  const panelOpen = target !== null && panelFor === target.pos && PANEL_TYPES.has(target.type)
  // The chart editor loads on demand. A selected diagram starts it, so it is
  // there when "Edit chart" opens.
  const isDiagram = target?.type === "mermaid"
  useEffect(() => {
    if (isDiagram) preloadCodeEditor("plain")
  }, [isDiagram])
  useEffect(() => {
    // The bar changed height. Its position is computed from its size.
    editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, "updatePosition"))
  }, [editor, panelOpen])

  // TipTap hides the bar when the editor loses focus, but not when focus
  // leaves one of the bar's own fields for somewhere else, such as a card
  // inside the page. Only the bar itself and the editable text keep it.
  const barRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const keepsBar = (next: EventTarget | null) =>
      next instanceof Node && (bar.contains(next) || next === editor.view.dom)
    const hide = () => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, "hide"))
    }
    let pending: number | undefined
    const onFocusOut = (event: FocusEvent) => {
      if (keepsBar(event.relatedTarget)) return
      if (event.relatedTarget === null) {
        // Focus has no target when a focused element of the bar is removed,
        // such as a picked option of the note type list, which then moves
        // focus back to its trigger. Only focus that leaves for the page
        // hides the bar.
        const left = event.target
        window.clearTimeout(pending)
        pending = window.setTimeout(() => {
          const removed = left instanceof Node && !left.isConnected
          if (!removed && !keepsBar(document.activeElement)) hide()
        })
        return
      }
      hide()
    }
    bar.addEventListener("focusout", onFocusOut)
    return () => {
      window.clearTimeout(pending)
      bar.removeEventListener("focusout", onFocusOut)
    }
  }, [editor])

  function remove() {
    const found = findComponent(editor.state, pickedRef.current)
    if (!found) return
    setPanelFor(null)
    editor.chain().focus().deleteRange({ from: found.pos, to: found.pos + found.node.nodeSize }).run()
  }

  const label = target ? COMPONENT_LABELS[target.type] : ""

  return (
    <BubbleMenu
      ref={barRef}
      editor={editor}
      pluginKey={PLUGIN_KEY}
      appendTo={appendTo}
      options={{ placement: "top-start", offset: 6, flip: false }}
      shouldShow={({ state, view, element }) => {
        if (!editor.isEditable) return false
        // Only while someone works in the editor or in this bar. A page that
        // opens with a note first must not open with the bar showing.
        if (!view.hasFocus() && !element.contains(document.activeElement)) return false
        const found = findComponent(state)
        if (!found) return false
        return state.selection.empty || state.selection instanceof NodeSelection || found.node.type.name === "table"
      }}
      getReferencedVirtualElement={() => {
        const found = findComponent(editor.state, pickedRef.current)
        const element = found ? editor.view.nodeDOM(found.pos) : null
        if (!(element instanceof HTMLElement)) return null
        return {
          getBoundingClientRect: () => element.getBoundingClientRect(),
          getClientRects: () => element.getClientRects(),
        }
      }}
      className="surface-menu z-40 flex flex-col font-sans"
    >
      {target ? (
        <>
          {panelOpen && target.type === "fileTree" ? (
            <FileTreePanel editor={editor} pos={target.pos} items={(target.attrs.items ?? []) as FileTreeItem[]} />
          ) : null}
          {panelOpen && target.type === "mermaid" ? (
            <MermaidPanel editor={editor} pos={target.pos} chart={String(target.attrs.chart ?? "")} />
          ) : null}
          <div className="flex items-center self-end">
            {around.chain.length > 1 ? (
              <ComponentPath
                chain={around.chain}
                current={target.pos}
                onPick={(pos) => {
                  setPanelFor(null)
                  setPicked(pos)
                }}
              />
            ) : (
              <ToolbarLabel>{label}</ToolbarLabel>
            )}
            {target.type === "callout" ? (
              <NoteControls editor={editor} pos={target.pos} attributes={(target.attrs.attributes ?? []) as MdxAttribute[]} />
            ) : target.type === "table" ? (
              <TableControls editor={editor} />
            ) : target.type === "steps" ? (
              <StepsControls editor={editor} pos={target.pos} />
            ) : target.type === "tabs" ? (
              <TabsControls editor={editor} pos={target.pos} />
            ) : target.type === "image" ? (
              <ImageControls editor={editor} pos={target.pos} alt={String(target.attrs.alt ?? "")} />
            ) : target.type === "embed" ? (
              <EmbedControls
                key={target.pos}
                editor={editor}
                pos={target.pos}
                attributes={(target.attrs.attributes ?? []) as MdxAttribute[]}
              />
            ) : PANEL_TYPES.has(target.type) ? (
              <ToolbarButton
                label={target.type === "mermaid" ? "Edit the chart" : "Edit the outline"}
                active={panelOpen}
                onClick={() => setPanelFor(panelOpen ? null : target.pos)}
              >
                {target.type === "mermaid" ? "Edit chart" : "Edit outline"}
              </ToolbarButton>
            ) : null}
            <ToolbarButton label={`Delete ${label.toLowerCase()}`} onClick={remove} className="text-danger hover:text-danger">
              <Trash2 className="size-3.5" />
            </ToolbarButton>
          </div>
        </>
      ) : null}
    </BubbleMenu>
  )
}

/**
 * The nested components around the cursor, outermost first, such as
 * TABS › TABLE. Each one opens its own controls in the bar.
 */
function ComponentPath({
  chain,
  current,
  onPick,
}: {
  chain: { type: string; pos: number }[]
  current: number
  onPick: (pos: number) => void
}) {
  return (
    <nav aria-label="Nested components" className="flex items-center border-r border-divider px-1">
      {chain.map((component, index) => (
        <span key={component.pos} className="flex items-center">
          {index > 0 ? <span aria-hidden="true" className="px-0.5 text-label">›</span> : null}
          <button
            type="button"
            onClick={() => onPick(component.pos)}
            onMouseDown={(event) => event.preventDefault()}
            aria-current={component.pos === current ? "true" : undefined}
            className={
              component.pos === current
                ? "px-1.5 py-1 font-mono text-[10px] font-medium tracking-[0.14em] text-primary-text uppercase"
                : "px-1.5 py-1 font-mono text-[10px] font-medium tracking-[0.14em] text-label uppercase transition-colors hover:text-foreground"
            }
          >
            {COMPONENT_LABELS[component.type]}
          </button>
        </span>
      ))}
    </nav>
  )
}

function ToolbarLabel({ children }: { children: ReactNode }) {
  return (
    <span className="border-r border-divider px-2.5 font-mono text-[10px] font-medium tracking-[0.14em] text-label uppercase">
      {children}
    </span>
  )
}

/** Sets one attribute of the block at `pos`, keeping the cursor where it is. */
function setAttribute(editor: Editor, pos: number, name: string, value: unknown) {
  editor
    .chain()
    .command(({ tr }) => {
      tr.setNodeAttribute(pos, name, value)
      return true
    })
    .run()
}

/** Add or remove a step. A new step comes after the one with the cursor. */
function StepsControls({ editor, pos }: { editor: Editor; pos: number }) {
  function addStep() {
    const steps = editor.state.doc.nodeAt(pos)
    if (!steps) return
    const current = childAtCursor(editor.state, pos)
    const at = current ? current.pos + current.node.nodeSize : pos + steps.nodeSize - 1
    editor
      .chain()
      .insertContentAt(at, { type: "stepItem", content: [{ type: "stepTitle" }, { type: "stepBody", content: [{ type: "paragraph" }] }] })
      .command(({ tr }) => {
        tr.setSelection(TextSelection.create(tr.doc, at + 2))
        return true
      })
      .focus()
      .run()
  }

  function removeStep() {
    const steps = editor.state.doc.nodeAt(pos)
    const current = childAtCursor(editor.state, pos)
    if (!steps || !current) return
    if (steps.childCount === 1) {
      editor.chain().focus().deleteRange({ from: pos, to: pos + steps.nodeSize }).run()
      return
    }
    editor.chain().focus().deleteRange({ from: current.pos, to: current.pos + current.node.nodeSize }).run()
  }

  return (
    <>
      <ToolbarButton label="Add a step below" onClick={addStep}>
        + Step
      </ToolbarButton>
      <ToolbarButton label="Delete this step" onClick={removeStep}>
        − Step
      </ToolbarButton>
    </>
  )
}

/** The label of the tab with the cursor, and adding or removing a tab. */
function TabsControls({ editor, pos }: { editor: Editor; pos: number }) {
  const current = useEditorState({
    editor,
    selector: ({ editor: state }) => {
      const found = childAtCursor(state.state, pos)
      return found ? { pos: found.pos, label: String(found.node.attrs.label ?? "") } : null
    },
    equalityFn: (left, right) => left?.pos === right?.pos && left?.label === right?.label,
  })

  function addTab() {
    const tabs = editor.state.doc.nodeAt(pos)
    if (!tabs) return
    const found = childAtCursor(editor.state, pos)
    const at = found ? found.pos + found.node.nodeSize : pos + tabs.nodeSize - 1
    const label = `Tab ${tabs.childCount + 1}`
    editor
      .chain()
      .insertContentAt(at, { type: "tabItem", attrs: { label }, content: [{ type: "paragraph" }] })
      .command(({ tr }) => {
        tr.setSelection(TextSelection.create(tr.doc, at + 2))
        return true
      })
      .focus()
      .run()
  }

  function removeTab() {
    const tabs = editor.state.doc.nodeAt(pos)
    const found = childAtCursor(editor.state, pos)
    if (!tabs || !found) return
    if (tabs.childCount === 1) {
      editor.chain().focus().deleteRange({ from: pos, to: pos + tabs.nodeSize }).run()
      return
    }
    editor.chain().focus().deleteRange({ from: found.pos, to: found.pos + found.node.nodeSize }).run()
  }

  return (
    <>
      {current ? (
        <div className="border-r border-divider px-1.5 py-1">
          <TextInput
            value={current.label}
            onValueChange={(value) => setAttribute(editor, current.pos, "label", value)}
            placeholder="Tab label"
            aria-label="Tab label"
            className="h-7 w-40 text-xs"
          />
        </div>
      ) : null}
      <ToolbarButton label="Add a tab after this one" onClick={addTab}>
        + Tab
      </ToolbarButton>
      <ToolbarButton label="Delete this tab" onClick={removeTab}>
        − Tab
      </ToolbarButton>
    </>
  )
}

/**
 * The file tree as an indented outline. A valid outline applies as it is
 * typed. An invalid one waits, with the reason shown under it.
 */
function FileTreePanel({ editor, pos, items }: { editor: Editor; pos: number; items: FileTreeItem[] }) {
  const [text, setText] = useState(() => formatOutline(items))
  const [error, setError] = useState<string | null>(null)

  function change(next: string) {
    setText(next)
    const result = parseOutline(next, items)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setAttribute(editor, pos, "items", result.items)
  }

  return (
    <div className="w-[380px] border-b border-divider p-3">
      <TextArea
        value={text}
        onValueChange={change}
        aria-label="File tree outline"
        spellCheck={false}
        autoFocus
        rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
        className="font-mono text-xs leading-5"
      />
      <p className={error ? "mt-2 text-xs text-danger" : "mt-2 text-xs text-muted-foreground"}>
        {error ?? "One item per line, two spaces per level. A folder ends with /. Add “ # Label” to show a label."}
      </p>
    </div>
  )
}

/** The diagram's Mermaid source. The diagram redraws as it changes. */
function MermaidPanel({ editor, pos, chart }: { editor: Editor; pos: number; chart: string }) {
  const [text, setText] = useState(chart)
  return (
    <div className="w-[440px] border-b border-divider">
      <div className="h-56 overflow-hidden">
        <LazyCodeEditor
          value={text}
          onChange={(next) => {
            setText(next)
            setAttribute(editor, pos, "chart", next)
          }}
          onSave={() => undefined}
          language="plain"
          ariaLabel="Mermaid chart"
        />
      </div>
      <p className="border-t border-divider px-3 py-2 text-xs text-muted-foreground">
        Mermaid syntax. See mermaid.js.org for the diagram types.
      </p>
    </div>
  )
}

function NoteControls({ editor, pos, attributes }: { editor: Editor; pos: number; attributes: MdxAttribute[] }) {
  const [typeField, titleField] = NOTE_PROPS as [Extract<PropField, { kind: "enum" }>, PropField]
  // The type list renders inside the bar. In `document.body`, focus would
  // leave the bar when the list opens, and TipTap would hide the bar.
  const [listContainer, setListContainer] = useState<HTMLDivElement | null>(null)

  function set(field: PropField, value: string) {
    // The cursor stays where it is. Only the note's attributes change.
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeAttribute(pos, "attributes", writeProp(attributes, field, value))
        return true
      })
      .run()
  }

  return (
    <>
      <div ref={setListContainer} className="flex items-center gap-1.5 border-r border-divider px-1.5 py-1">
        <Select
          value={String(readProp(attributes, typeField))}
          options={typeField.options}
          onValueChange={(value) => set(typeField, value)}
          container={listContainer}
          aria-label="Note type"
          className="h-7 w-28 text-xs"
        />
        <TextInput
          value={String(readProp(attributes, titleField))}
          onValueChange={(value) => set(titleField, value)}
          placeholder="Note"
          aria-label="Note title"
          className="h-7 w-40 text-xs"
        />
      </div>
    </>
  )
}

/**
 * A selected image: a Replace button that opens the file picker and also
 * takes a dropped file, and the alt text, which starts as the file name.
 */
function ImageControls({ editor, pos, alt }: { editor: Editor; pos: number; alt: string }) {
  return (
    <>
      {canUploadImages(editor) ? (
        <ImageDropzone
          onFiles={(files) => uploadIntoImage(editor, pos, files)}
          title="Replace the image: click, or drop a file here"
          className="h-8 w-auto flex-row gap-1.5 border-r border-divider px-2.5 font-mono text-xs font-medium text-body hover:text-foreground"
        >
          <ImageUp className="size-3.5" />
          Replace
        </ImageDropzone>
      ) : null}
      <div className="flex items-center border-r border-divider px-1.5 py-1">
        <TextInput
          value={alt}
          onValueChange={(value) => setAttribute(editor, pos, "alt", value.replace(/[[\]\n]/g, ""))}
          placeholder="Alt text"
          aria-label="Alt text"
          title="Alt text: describes the image for screen readers"
          className="h-7 w-80 max-w-[45vw] text-xs"
        />
      </div>
    </>
  )
}

/** A selected video: its YouTube, Vimeo or Loom link. */
function EmbedControls({ editor, pos, attributes }: { editor: Editor; pos: number; attributes: MdxAttribute[] }) {
  return (
    <div className="flex items-center border-r border-divider px-1.5 py-1">
      <EmbedLinkField
        url={String(readProp(attributes, EMBED_URL_PROP))}
        onCommit={(next) => setAttribute(editor, pos, "attributes", writeProp(attributes, EMBED_URL_PROP, next))}
        inputClassName="h-7 w-80 max-w-[45vw] text-xs"
        errorPlacement="tooltip"
      />
    </div>
  )
}

/** Row and column actions for the table around the cursor. */
function TableControls({ editor }: { editor: Editor }) {
  const run = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => command(editor.chain().focus()).run()
  return (
    <>
      <ToolbarButton label="Add a row below" onClick={() => run((chain) => chain.addRowAfter())}>
        + Row
      </ToolbarButton>
      <ToolbarButton label="Add a column to the right" onClick={() => run((chain) => chain.addColumnAfter())}>
        + Column
      </ToolbarButton>
      <ToolbarButton label="Delete this row" onClick={() => run((chain) => chain.deleteRow())}>
        − Row
      </ToolbarButton>
      <ToolbarButton label="Delete this column" onClick={() => run((chain) => chain.deleteColumn())}>
        − Column
      </ToolbarButton>
    </>
  )
}

