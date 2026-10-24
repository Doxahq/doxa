import { lazy, Suspense, useState } from "react"
import { Note, type NoteVariant } from "@doxahq/docs-prose"
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import { Code2 } from "lucide-react"

import { LazyCodeEditor, preloadCodeEditor } from "~/components/code-editor/lazy-code-editor"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { BlockPreviewFrame, BlockPreviewPlaceholder } from "~/components/dashboard/content/write-editor/block-preview-frame"
import { CardGroupView } from "~/components/dashboard/content/write-editor/card-group-view"
import {
  FileTreeView,
  MermaidView,
  StepItemView,
  StepsView,
  TabsView,
} from "~/components/dashboard/content/write-editor/container-views"
import { EmbedView, ImageView } from "~/components/dashboard/content/write-editor/media-views"
import type { MdxAttribute } from "~/lib/editor/mdx-document"
import type { WriteNodeViews } from "~/lib/editor/write-extensions"

const MdxPreview = lazy(() => import("~/components/dashboard/content/mdx-preview"))

/**
 * Code: the published code fence, with the language label as an input in the
 * corner where the site shows it.
 */
function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const language = (node.attrs.language as string | null) ?? ""
  return (
    <NodeViewWrapper className="relative my-5">
      <div
        contentEditable={false}
        className="absolute top-2 right-2 z-10 flex items-center gap-2 sm:top-3 sm:right-2.5"
      >
        <input
          value={language}
          onChange={(event) => updateAttributes({ language: event.currentTarget.value.trim() || null })}
          placeholder="language"
          aria-label="Code language"
          spellCheck={false}
          disabled={!editor.isEditable}
          size={Math.max(language.length, 8)}
          className="bg-transparent text-right font-mono text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      <div className="relative">
        <pre data-language={language || undefined}>
          <NodeViewContent<"code"> as="code" />
        </pre>
      </div>
    </NodeViewWrapper>
  )
}

const NOTE_VARIANTS: readonly NoteVariant[] = ["note", "success", "warning", "danger"]

/** Callout: the published `<Note>`, with its body editable in place. */
function CalloutView({ node }: ReactNodeViewProps) {
  const attributes = (node.attrs.attributes ?? []) as MdxAttribute[]
  const title = attributes.find(({ name }) => name === "title")?.value ?? undefined
  const type = attributes.find(({ name }) => name === "type")?.value
  return (
    <NodeViewWrapper>
      <Note title={title} type={NOTE_VARIANTS.find((variant) => variant === type)}>
        <NodeViewContent />
      </Note>
    </NodeViewWrapper>
  )
}

/**
 * A block the editor cannot model: API components, JavaScript, and
 * components written in a shape the editor does not read. It renders with the shared docs components inside the page's
 * article, and keeps its source as it is. "Edit MDX" opens the source in the
 * code editor. The dialog is a portal, so it keeps the dashboard look.
 */
function MdxBlockView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const source = String(node.attrs.source ?? "")
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <NodeViewWrapper className="doxa-mdx-block" data-selected={selected || undefined}>
      <div contentEditable={false}>
        <div className="not-prose flex items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          <span className="font-mono text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
            MDX · {blockLabel(source)}
          </span>
          <button
            type="button"
            disabled={!editor.isEditable}
            // The source editor loads on demand. Pointing at the button starts it.
            onPointerEnter={() => preloadCodeEditor("mdx")}
            onFocus={() => preloadCodeEditor("mdx")}
            onClick={() => setDraft(source)}
            className="flex items-center gap-1.5 px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Code2 className="size-3.5" />
            Edit MDX
          </button>
        </div>
        {/* The block holds its drawn size until it draws, both while the preview code loads and on its first frame. */}
        <BlockPreviewFrame source={source}>
          <Suspense fallback={<BlockPreviewPlaceholder source={source} />}>
            <MdxPreview source={source} variant="block" placeholder={<BlockPreviewPlaceholder source={source} />} />
          </Suspense>
        </BlockPreviewFrame>
      </div>

      <Dialog open={draft !== null} onOpenChange={(open) => (open ? undefined : setDraft(null))}>
        <DialogContent className="flex h-[min(80dvh,44rem)] max-w-3xl flex-col">
          <DialogHeader>
            <DialogTitle>Edit MDX block</DialogTitle>
            <DialogDescription>
              This block keeps its MDX exactly as written. Edit the source directly.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex min-h-0 flex-1 flex-col p-0">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-y border-border">
              {draft !== null ? (
                <LazyCodeEditor
                  value={draft}
                  onChange={setDraft}
                  onSave={() => {
                    updateAttributes({ source: draft })
                    setDraft(null)
                  }}
                  language="mdx"
                  ariaLabel="MDX block source"
                />
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (draft !== null && draft.trim()) updateAttributes({ source: draft.trim() })
                setDraft(null)
              }}
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </NodeViewWrapper>
  )
}

/** A short name for a locked block: its component, or "Table", "Import"… */
function blockLabel(source: string): string {
  const component = /^<([A-Z][\w.]*)/.exec(source.trimStart())?.[1]
  if (component) return component
  if (/^\|/.test(source.trimStart())) return "Table"
  if (/^(import|export)\s/.test(source.trimStart())) return "Import"
  return "Block"
}

/** Stops the editor from handling keys and clicks meant for a field inside a node view. */
const insideField = ({ event }: { event: Event }) =>
  event.target instanceof HTMLElement &&
  event.target.closest("input, textarea, select, button, [role='button'], [role='dialog']") !== null

export const WRITE_NODE_VIEWS: WriteNodeViews = {
  codeBlock: ReactNodeViewRenderer(CodeBlockView, { stopEvent: insideField }),
  callout: ReactNodeViewRenderer(CalloutView),
  cardGroup: ReactNodeViewRenderer(CardGroupView, { stopEvent: insideField }),
  mdxBlock: ReactNodeViewRenderer(MdxBlockView, { stopEvent: insideField }),
  steps: ReactNodeViewRenderer(StepsView),
  stepItem: ReactNodeViewRenderer(StepItemView),
  tabs: ReactNodeViewRenderer(TabsView, { stopEvent: insideField }),
  fileTree: ReactNodeViewRenderer(FileTreeView, { stopEvent: insideField }),
  mermaid: ReactNodeViewRenderer(MermaidView),
  image: ReactNodeViewRenderer(ImageView, { stopEvent: insideField }),
  embed: ReactNodeViewRenderer(EmbedView, { stopEvent: insideField }),
}
