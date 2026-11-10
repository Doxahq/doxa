import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { ARTICLE_PROSE_CLASS } from "@doxahq/docs-prose"
import type { ResolvedTheme } from "@doxahq/site-config"
import { Extension, type Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"

import { SiteCanvas } from "~/components/dashboard/content/site-canvas"
import { SegmentedControl } from "~/components/dashboard/content/site-settings/fields/controls"
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip"

import { BlockGutter } from "~/components/dashboard/content/write-editor/block-gutter"
import { ComponentToolbar } from "~/components/dashboard/content/write-editor/component-toolbar"
import { WRITE_NODE_VIEWS } from "~/components/dashboard/content/write-editor/node-views"
import { PageOutline } from "~/components/dashboard/content/write-editor/page-outline"
import {
  PAGE_ICON_HOVER_GROUP,
  PageIconPicker,
  type PageIconEdit,
} from "~/components/dashboard/content/write-editor/page-icon-picker"
import {
  PAGE_SLUG_HOVER_GROUP,
  PageSlugField,
  type PageSlugEdit,
} from "~/components/dashboard/content/write-editor/page-slug-field"
import { SelectionToolbar } from "~/components/dashboard/content/write-editor/selection-toolbar"
import { createSlashCommand, SlashMenu, SlashMenuStore } from "~/components/dashboard/content/write-editor/slash-menu"
import { captureOriginalBlocks, serializeMdxDocument, type MdxDocument } from "~/lib/editor/mdx-document"
import { parseMdxDocumentCached } from "~/lib/editor/mdx-document-cache"
import { useImageUploader } from "~/lib/dashboard/editor-assets"
import { hasLightMode, type CanvasMode } from "~/lib/dashboard/site-canvas"
import { CodeHighlight } from "~/lib/editor/code-highlight"
import { releaseBlockSelection } from "~/lib/editor/block-selection"
import { createImageUpload } from "~/lib/editor/image-upload"
import { MdxPaste } from "~/lib/editor/mdx-paste"
import {
  AgentChangeHighlight,
  refreshChangeAges,
  showAgentChanges,
  type AgentChangeView,
} from "~/lib/editor/agent-change-highlight"
import { createWriteExtensions } from "~/lib/editor/write-extensions"
import { cn } from "~/lib/utils"

export interface WriteEditorProps {
  /** The page source. */
  value: string
  /** Receives the new source after every edit. */
  onChange: (value: string) => void
  onSave: () => void
  readOnly?: boolean
  /** An agent's edits of this page. The blocks that they changed get a tint and an age label. */
  agentChanges?: AgentChangeView | null
  page: {
    href: string | null
    status: "published" | "edited" | null
    /** Null when the page URL cannot change here. */
    slugEdit?: PageSlugEdit | null
    /** The page icon beside the title. Null when the page has no navigation entry to hold one. */
    iconEdit?: PageIconEdit | null
    /** True for the default page: the site root (`/`) shows it. */
    isIndex?: boolean
  }
  /** Shows "On this page". Focus mode hides it. */
  showOutline: boolean
  /** The site theme the page is drawn with, and the color mode shown. */
  canvas: {
    theme: ResolvedTheme
    mode: CanvasMode
    onModeChange: (mode: CanvasMode) => void
  }
}

/**
 * The rich page editor.
 *
 * It reads and writes the same MDX string as the source editor, through the
 * same `onChange`, so saving, autosave, revert, discard and publish do not
 * change. Blocks the user does not touch keep their text byte for byte.
 *
 * The page is drawn inside a `SiteCanvas` with the published article classes,
 * so it looks as it does on the site. Editor chrome (the page facts strip, the
 * block menu, the selection bar) stays outside the canvas and keeps the
 * dashboard look.
 */
export default function WriteEditor({
  value,
  onChange,
  onSave,
  readOnly = false,
  agentChanges = null,
  page,
  showOutline,
  canvas,
}: WriteEditorProps) {
  // Parsed once per mount, not on every render: a render happens on each keystroke.
  const [initialDocument] = useState(() => parseMdxDocumentCached(value))
  const documentRef = useRef<MdxDocument>(initialDocument)
  const originalsRef = useRef<Map<number, string>>(new Map())
  const originalsCapturedRef = useRef(false)
  const lastEmittedRef = useRef(value)
  const [meta, setMeta] = useState(() => ({
    title: documentRef.current.title,
    description: documentRef.current.description,
  }))
  const metaRef = useRef(meta)
  metaRef.current = meta
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const agentChangesRef = useRef(agentChanges)
  agentChangesRef.current = agentChanges
  const revealedAgentChangeRef = useRef<string | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const menuLayerRef = useRef<HTMLDivElement | null>(null)
  const menuLayer = () => menuLayerRef.current ?? document.body
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null)
  const [slashStore] = useState(() => new SlashMenuStore())
  // The branch can change while the editor stays mounted, so the extension
  // reads the current uploader on each upload.
  const uploader = useImageUploader()
  const uploaderRef = useRef(uploader)
  uploaderRef.current = uploader

  const extensions = useMemo(
    () =>
      createWriteExtensions(WRITE_NODE_VIEWS, [
        CodeHighlight,
        // Before the MDX paste: a copied file also brings its name as text.
        createImageUpload({ getUploader: () => uploaderRef.current }),
        MdxPaste,
        AgentChangeHighlight,
        createSlashCommand(slashStore),
        Extension.create({
          name: "saveShortcut",
          addKeyboardShortcuts: () => ({
            "Mod-s": () => {
              onSaveRef.current()
              return true
            },
          }),
        }),
      ]),
    [slashStore],
  )

  function emit(editor: Editor) {
    // Until the loaded blocks are recorded, every block would look edited and
    // the whole page would be rewritten. Nothing is typed before that moment.
    if (!originalsCapturedRef.current) return
    const text = serializeMdxDocument(documentRef.current, editor.getJSON(), originalsRef.current, metaRef.current)
    if (text === lastEmittedRef.current) return
    lastEmittedRef.current = text
    onChangeRef.current(text)
  }

  const editor = useEditor({
    extensions,
    content: documentRef.current.content,
    // The dashboard renders on the server too. The editor mounts on the client only.
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editable: !readOnly,
    editorProps: { attributes: { class: "doxa-write-content", "aria-label": "Page content" } },
    onCreate: ({ editor: created }) => {
      originalsRef.current = captureOriginalBlocks(created.getJSON())
      originalsCapturedRef.current = true
    },
    onUpdate: ({ editor: updated }) => emit(updated),
  })

  // A new source from outside (a page switch, a revert, the MDX editor)
  // reloads the document. The editor's own edits come back unchanged and are skipped.
  useEffect(() => {
    if (!editor || value === lastEmittedRef.current) return
    const next = parseMdxDocumentCached(value)
    documentRef.current = next
    lastEmittedRef.current = value
    setMeta({ title: next.title, description: next.description })
    editor.commands.setContent(next.content, { emitUpdate: false })
    // The whole page was replaced, so the selection landed on the last block.
    releaseBlockSelection(editor)
    originalsRef.current = captureOriginalBlocks(editor.getJSON())
    showAgentChanges(editor, next.content, agentChangesRef.current, revealedAgentChangeRef)
  }, [editor, value])

  // A followed page opens as a new editor, so its marks come from here. This
  // runs after the effect above, so it sees the current document.
  const agentPageChanges = agentChanges?.changes ?? null
  const reviewedAgentChange = agentChanges?.reviewed ?? null
  const showAgentMarks = agentChanges?.showMarks ?? false
  useEffect(() => {
    if (editor) showAgentChanges(editor, documentRef.current.content, agentChangesRef.current, revealedAgentChangeRef)
  }, [editor, agentPageChanges, reviewedAgentChange, showAgentMarks])

  const agentClock = agentChanges?.now ?? null
  useEffect(() => {
    if (editor && agentClock) refreshChangeAges(editor, agentClock)
  }, [editor, agentClock])

  useEffect(() => {
    // `setEditable` sends an update event unless told not to. An update is
    // treated as an edit, so a mode change must not send one.
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly, false)
  }, [editor, readOnly])

  // A click outside the page lets go of a selected block (an image, a video,
  // a card group, a locked MDX block). Otherwise its outline stays on while
  // its bar is gone. A click on the editor's own chrome keeps it.
  useEffect(() => {
    if (!editor) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || editor.isDestroyed) return
      if (editor.view.dom.contains(target) || menuLayerRef.current?.contains(target)) return
      if (target.closest(KEEPS_BLOCK_SELECTION)) return
      releaseBlockSelection(editor)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [editor])

  function updateMeta(field: "title" | "description", text: string) {
    const next = { ...metaRef.current, [field]: text.replace(/\n/g, " ") }
    metaRef.current = next
    setMeta(next)
    if (editor) emit(editor)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageProperties page={page} canvas={canvas} readOnly={readOnly} />
      {/* The padding follows the pane, not the window, so a narrow pane gets a compact column. */}
      <div ref={scrollRef} className="scrollbar-subtle @container relative min-h-0 flex-1 overflow-y-auto">
        <SiteCanvas theme={canvas.theme} mode={canvas.mode} className="min-h-full">
          <div className="flex justify-center gap-14 px-12 pt-14 pb-40 @max-[640px]:px-6 @max-[640px]:pt-9 @max-[420px]:px-5">
            <div className="doxa-write relative w-full max-w-3xl min-w-0">
              {/* The docs route's article: title, description, then the body in `.prose-content`. */}
              <article className={ARTICLE_PROSE_CLASS}>
                {/* The icon sits in the gutter beside the title, so the title keeps its place on the site. */}
                <div className={cn("not-prose relative", PAGE_ICON_HOVER_GROUP)}>
                  {page.iconEdit ? (
                    <PageIconPicker
                      edit={page.iconEdit}
                      disabled={readOnly}
                      className="absolute top-[-2px] right-full mr-2 lg:top-0 @max-[640px]:mr-0.5 @max-[640px]:size-6 @max-[640px]:[&_svg]:size-4"
                    />
                  ) : null}
                  <AutoTextarea
                    value={meta.title}
                    onChange={(text) => updateMeta("title", text)}
                    onEnter={() => descriptionRef.current?.focus()}
                    placeholder="Untitled"
                    ariaLabel="Page title"
                    readOnly={readOnly}
                    className="not-prose text-3xl font-bold tracking-tight lg:text-4xl"
                  />
                </div>
                <AutoTextarea
                  textareaRef={descriptionRef}
                  value={meta.description}
                  onChange={(text) => updateMeta("description", text)}
                  onEnter={() => editor?.commands.focus("start")}
                  placeholder="Add a short description"
                  ariaLabel="Page description"
                  readOnly={readOnly}
                  className="not-prose mt-3 text-lg text-muted-foreground"
                />
                <div className="prose-content mt-8">
                  {editor ? <EditorContent editor={editor} /> : <div className="h-64" aria-hidden="true" />}
                </div>
              </article>
              {editor && !readOnly ? <BlockGutter editor={editor} /> : null}
            </div>
            {showOutline && editor ? <PageOutline editor={editor} scrollRef={scrollRef} /> : null}
          </div>
        </SiteCanvas>
        {/* Dashboard chrome that follows the text mounts here, outside the canvas. */}
        <div ref={menuLayerRef} />
        {editor && !readOnly ? (
          <>
            <SelectionToolbar editor={editor} appendTo={menuLayer} />
            <ComponentToolbar editor={editor} appendTo={menuLayer} />
          </>
        ) : null}
        <SlashMenu store={slashStore} />
      </div>
    </div>
  )
}

/**
 * Places that act on the selected block: the block gutter, and menus,
 * popovers and dialogs that portal out of the editor.
 */
const KEEPS_BLOCK_SELECTION =
  ".doxa-gutter, [data-radix-popper-content-wrapper], [role='dialog'], [role='menu'], [role='listbox']"

/**
 * The strip above the page: the SLUG, with a dot when the page has unpublished
 * changes, and the color mode the page is drawn in. It is editor chrome, so it
 * sits outside the site canvas.
 */
function PageProperties({
  page,
  canvas,
  readOnly,
}: Pick<WriteEditorProps, "page" | "canvas"> & { readOnly: boolean }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 border-b border-border bg-editor px-4">
      <dl className="flex flex-wrap">
        {page.href ? (
          // The whole row reveals the pencil, so the label is a target too.
          <Property label="Slug" className={PAGE_SLUG_HOVER_GROUP}>
            <PageSlugField
              href={page.href}
              edit={page.slugEdit ?? null}
              isIndex={page.isIndex ?? false}
              disabled={readOnly}
              after={page.status === "edited" ? <UnpublishedDot /> : null}
            />
          </Property>
        ) : null}
      </dl>
      <div className="flex items-center gap-2.5 py-1.5">
        <span className="font-mono text-[10px] font-medium tracking-[0.16em] text-label uppercase">Site theme</span>
        {hasLightMode(canvas.theme) ? (
          <SegmentedControl
            label="Site color mode"
            value={canvas.mode}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onValueChange={canvas.onModeChange}
          />
        ) : (
          <span className="text-xs text-muted-foreground">Dark only</span>
        )}
      </div>
    </div>
  )
}

/**
 * The same dot as the page tree. The box around it gives the tooltip a target
 * that a pointer can find.
 */
function UnpublishedDot() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label="Unpublished changes" className="flex size-4 items-center justify-center">
          <span className="size-1.5 rounded-full bg-warning" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        Unpublished changes
      </TooltipContent>
    </Tooltip>
  )
}

function Property({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("mr-4 flex items-center gap-2.5 py-2.5 pr-4", className)}>
      <dt className="font-mono text-[10px] font-medium tracking-[0.16em] text-label uppercase">{label}</dt>
      <dd className="flex min-w-0 items-center">{children}</dd>
    </div>
  )
}

/** A one-paragraph field that grows with its text. Enter moves on instead of adding a line. */
function AutoTextarea({
  value,
  onChange,
  onEnter,
  placeholder,
  ariaLabel,
  readOnly,
  className,
  textareaRef,
}: {
  value: string
  onChange: (value: string) => void
  onEnter: () => void
  placeholder: string
  ariaLabel: string
  readOnly: boolean
  className?: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
}) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null)
  const ref = textareaRef ?? ownRef

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight}px`
  }, [ref, value])

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault()
          onEnter()
        }
      }}
      className={cn(
        "block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted-foreground/60 focus-visible:outline-none",
        className,
      )}
    />
  )
}
