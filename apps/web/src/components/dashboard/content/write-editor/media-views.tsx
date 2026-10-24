import { useEffect, useRef, useState, type ReactNode } from "react"
import { Embed } from "@doxahq/docs-prose"
import { resolveEmbedUrl } from "@doxahq/mdx-runtime"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { ImageOff, ImagePlus, Loader2, PlayCircle, X } from "lucide-react"

import { TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import { useImageSource } from "~/lib/dashboard/editor-assets"
import { IMAGE_UPLOAD_ACCEPT } from "~/lib/editor/image-file"
import { EMBED_URL_PROP, readProp, writeProp } from "~/lib/editor/component-props"
import { canUploadImages, uploadIntoImage, uploadPreview } from "~/lib/editor/image-upload"
import type { MdxAttribute } from "~/lib/editor/mdx-document"
import { cn } from "~/lib/utils"

/**
 * An image as the site draws it: an `<img>` in a paragraph of the article.
 *
 * A new image is an empty drop area: a click opens the file picker, and an
 * image file can be dropped on it. While it uploads it shows the local file.
 * When selected, the component bar replaces the file, edits the alt text or
 * deletes the image. An image without a file is not saved.
 */
export function ImageView({ node, editor, selected, getPos, deleteNode }: ReactNodeViewProps) {
  const src = String(node.attrs.src ?? "")
  const alt = String(node.attrs.alt ?? "")
  const uploadId = (node.attrs.uploadId as string | null) ?? null
  const preview = uploadPreview(editor, uploadId)
  const source = useImageSource(src)
  const url = preview ?? source.url
  const editable = editor.isEditable

  function upload(files: readonly File[]) {
    const position = getPos()
    if (typeof position === "number") uploadIntoImage(editor, position, files)
  }

  if (!src && !uploadId) {
    return (
      <NodeViewWrapper className="doxa-atom-block" data-selected={selected || undefined}>
        <div contentEditable={false} className="not-prose my-6">
          <MediaPlaceholder onRemove={editable ? deleteNode : undefined}>
            {editable && canUploadImages(editor) ? (
              <ImageDropzone onFiles={upload} className="h-44">
                <ImagePlus className="size-6" />
                <span className="text-sm text-foreground">Click to upload an image, or drag and drop it here</span>
                <span className="text-xs">PNG, JPEG, WebP, GIF or SVG</span>
              </ImageDropzone>
            ) : (
              <div className="flex h-44 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <ImagePlus className="size-6" />
                This image has no file yet.
              </div>
            )}
          </MediaPlaceholder>
        </div>
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper className="doxa-atom-block" data-selected={selected || undefined}>
      <div contentEditable={false}>
        <p className="relative">
          {url ? (
            <img src={url} alt={alt} title={node.attrs.title ?? undefined} draggable={false} />
          ) : (
            <span className="not-prose flex h-40 flex-col items-center justify-center gap-2 border border-dashed border-border text-sm text-muted-foreground">
              {source.failed ? <ImageOff className="size-5" /> : <Loader2 className="size-5 animate-spin" />}
              {source.failed ? `This image could not be loaded: ${src}` : null}
            </span>
          )}
          {uploadId ? (
            <span className="not-prose absolute top-2 left-2 flex items-center gap-1.5 bg-background/85 px-2 py-1 font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">
              <Loader2 className="size-3 animate-spin" />
              Uploading
            </span>
          ) : null}
        </p>
      </div>
    </NodeViewWrapper>
  )
}

/**
 * A YouTube, Vimeo or Loom video, drawn with the site's `<Embed>`.
 *
 * A new embed is an empty area with a link field. The video never plays in
 * the editor: a click selects it, and the component bar changes the link or
 * deletes it. An embed without a link is not saved.
 */
export function EmbedView({ node, editor, selected, deleteNode, updateAttributes }: ReactNodeViewProps) {
  const attributes = (node.attrs.attributes ?? []) as MdxAttribute[]
  const url = String(readProp(attributes, EMBED_URL_PROP))
  const title = attributes.find((attribute) => attribute.name === "title")?.value ?? ""
  const resolved = resolveEmbedUrl(url)
  const editable = editor.isEditable

  function setUrl(next: string) {
    if (next !== url) updateAttributes({ attributes: writeProp(attributes, EMBED_URL_PROP, next) })
  }

  if (!resolved) {
    return (
      <NodeViewWrapper className="doxa-atom-block" data-selected={selected || undefined}>
        <div contentEditable={false} className="not-prose my-6">
          <MediaPlaceholder onRemove={editable ? deleteNode : undefined}>
            <div className="flex h-44 flex-col items-center justify-center gap-3 px-6 text-muted-foreground">
              <PlayCircle className="size-6" />
              <span className="text-sm text-foreground">Embed a YouTube, Vimeo or Loom video</span>
              {editable ? (
                <EmbedLinkField url={url} onCommit={setUrl} autoFocus={!url} className="w-full max-w-sm" />
              ) : (
                <span className="text-xs">{url ? "This link is not a YouTube, Vimeo or Loom video." : null}</span>
              )}
            </div>
          </MediaPlaceholder>
        </div>
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper className="doxa-atom-block" data-selected={selected || undefined}>
      <div contentEditable={false} className="relative">
        {/* The video does not play in the editor: a click selects the block. The preview plays it. */}
        <div inert>
          <Embed url={url} title={title || undefined} />
        </div>
        <div className="absolute inset-0 cursor-default" aria-hidden="true" />
      </div>
    </NodeViewWrapper>
  )
}

/** The dashed frame of an image or video that has no content yet, with a remove button. */
function MediaPlaceholder({ onRemove, children }: { onRemove?: () => void; children: ReactNode }) {
  return (
    <div className="relative border border-dashed border-border">
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          title="Remove"
          className="absolute top-1.5 right-1.5 grid size-7 place-items-center text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * An area that takes an image file: a click opens the file picker, and a
 * file can be dropped on it. The editor ignores events inside it
 * (`data-media-dropzone`), so a drop does not also land in the page.
 */
export function ImageDropzone({
  onFiles,
  title,
  className,
  children,
}: {
  onFiles: (files: File[]) => void
  title?: string
  className?: string
  children: ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <button
      type="button"
      data-media-dropzone=""
      data-over={over || undefined}
      title={title}
      onClick={() => inputRef.current?.click()}
      onDragEnter={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setOver(false)
        onFiles(Array.from(event.dataTransfer.files))
      }}
      className={cn(
        "flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 font-sans text-muted-foreground transition-colors hover:bg-overlay data-over:bg-overlay data-over:text-foreground",
        className,
      )}
    >
      {children}
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_UPLOAD_ACCEPT}
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ""
          if (files.length > 0) onFiles(files)
        }}
      />
    </button>
  )
}

const UNSUPPORTED_LINK = "Use a YouTube, Vimeo or Loom link."

/**
 * A video link field. It saves on Enter or when it loses focus, and only a
 * YouTube, Vimeo or Loom link.
 */
export function EmbedLinkField({
  id,
  url,
  onCommit,
  autoFocus,
  className,
  inputClassName = "h-8",
  errorPlacement = "below",
}: {
  id?: string
  url: string
  onCommit: (url: string) => void
  autoFocus?: boolean
  className?: string
  inputClassName?: string
  /** In a one-line bar there is no room below, so the error is the field's title. */
  errorPlacement?: "below" | "tooltip"
}) {
  const [draft, setDraft] = useState(url)
  useEffect(() => setDraft(url), [url])
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    // After the editor takes focus back from the command that added the embed.
    const timer = setTimeout(() => inputRef.current?.focus())
    return () => clearTimeout(timer)
    // Only when the field first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const unsupported = draft.trim() !== "" && !resolveEmbedUrl(draft)

  function commit() {
    const next = draft.trim()
    if (next && resolveEmbedUrl(next)) onCommit(next)
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <TextInput
        ref={inputRef}
        id={id}
        value={draft}
        onValueChange={setDraft}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
          }
        }}
        placeholder={EMBED_URL_PROP.kind === "link" ? EMBED_URL_PROP.placeholder : undefined}
        aria-label={id ? undefined : "Video link"}
        aria-invalid={unsupported || undefined}
        title={unsupported && errorPlacement === "tooltip" ? UNSUPPORTED_LINK : undefined}
        className={cn(inputClassName, unsupported && "border-destructive")}
      />
      {unsupported && errorPlacement === "below" ? <p className="text-xs text-destructive">{UNSUPPORTED_LINK}</p> : null}
    </div>
  )
}
