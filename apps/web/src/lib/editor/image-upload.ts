import { Extension, type Editor, type JSONContent } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"

import {
  altTextFromFileName,
  imageFiles,
  imageTooLargeMessage,
  prepareImageUpload,
} from "~/lib/editor/image-file"

/** Sends one image to the branch and returns the path the page links to. */
export interface ImageUploader {
  upload(file: File): Promise<{ path: string }>
  onError(error: unknown, file: File): void
}

export interface ImageUploadOptions {
  /** The uploader of the open page, or null when this editor cannot upload. */
  getUploader: () => ImageUploader | null
}

export interface ImageUploadStorage {
  getUploader: () => ImageUploader | null
  /** A local preview of each image still uploading, by `uploadId`. */
  previews: Map<string, string>
  /**
   * What each upload falls back to if it fails, by `uploadId`: the image as it
   * was before, or null to take the image off the page.
   */
  fallbacks: Map<string, Record<string, unknown> | null>
}

declare module "@tiptap/core" {
  interface Storage {
    imageUpload: ImageUploadStorage
  }
}

/** True when this editor can add images: it is editable and has an uploader. */
export function canUploadImages(editor: Editor): boolean {
  return editor.isEditable && Boolean(editor.storage.imageUpload?.getUploader())
}

/** The local preview of an image that is still uploading, or null. */
export function uploadPreview(editor: Editor, uploadId: string | null): string | null {
  return uploadId ? (editor.storage.imageUpload?.previews.get(uploadId) ?? null) : null
}

/**
 * Puts the images where `position` is (the selection by default) and uploads
 * them. Each image shows its local preview at once. When its upload ends, it
 * takes the returned path, or leaves the page and the uploader reports why.
 */
export function insertImageFiles(editor: Editor, files: readonly File[], position?: number): boolean {
  const uploader = editor.storage.imageUpload?.getUploader()
  const images = imageFiles(files)
  if (!uploader || images.length === 0 || !editor.isEditable) return false

  const pending = images.map((file) => ({ file, uploadId: startPreview(editor, file, null) }))
  const nodes: JSONContent[] = pending.map(({ file, uploadId }) => ({
    type: "image",
    attrs: { src: "", alt: altTextFromFileName(file.name), uploadId },
  }))
  const chain = editor.chain().focus()
  if (position === undefined) chain.insertContent(nodes)
  else chain.insertContentAt(position, nodes)
  chain.run()

  for (const { file, uploadId } of pending) void uploadOne(editor, uploader, file, uploadId)
  return true
}

/**
 * Uploads `file` into the image block at `position`: an empty placeholder or
 * an image to replace. The alt text becomes the new file's name. If the
 * upload fails, the block goes back to what it was.
 */
export function uploadIntoImage(editor: Editor, position: number, files: readonly File[]): boolean {
  const uploader = editor.storage.imageUpload?.getUploader()
  const [file] = imageFiles(files)
  const node = editor.state.doc.nodeAt(position)
  if (!uploader || !file || !editor.isEditable || node?.type.name !== "image" || node.attrs.uploadId) return false

  const before = { ...node.attrs, uploadId: null }
  const uploadId = startPreview(editor, file, before)
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(position, undefined, {
      ...node.attrs,
      alt: altTextFromFileName(file.name),
      uploadId,
    }),
  )
  void uploadOne(editor, uploader, file, uploadId)
  return true
}

function startPreview(editor: Editor, file: File, fallback: Record<string, unknown> | null): string {
  const uploadId = crypto.randomUUID()
  editor.storage.imageUpload.previews.set(uploadId, URL.createObjectURL(file))
  editor.storage.imageUpload.fallbacks.set(uploadId, fallback)
  return uploadId
}

async function uploadOne(editor: Editor, uploader: ImageUploader, file: File, uploadId: string): Promise<void> {
  try {
    const prepared = await prepareImageUpload(file)
    const tooLarge = imageTooLargeMessage(prepared)
    if (tooLarge) throw new Error(tooLarge)
    const { path } = await uploader.upload(prepared)
    settle(editor, uploadId, (attrs) => ({ ...attrs, src: path, uploadId: null }))
  } catch (error) {
    const fallback = editor.storage.imageUpload?.fallbacks.get(uploadId) ?? null
    settle(editor, uploadId, fallback ? () => fallback : null)
    uploader.onError(error, file)
  } finally {
    const preview = editor.storage.imageUpload?.previews.get(uploadId)
    editor.storage.imageUpload?.previews.delete(uploadId)
    editor.storage.imageUpload?.fallbacks.delete(uploadId)
    // The view switches to the stored image first; the preview goes after.
    if (preview) setTimeout(() => URL.revokeObjectURL(preview), 1_000)
  }
}

/**
 * Updates or removes the image that waits for `uploadId`, wherever edits have
 * moved it. The change stays out of the undo history: undo takes back the
 * whole upload as one step, as the author made it.
 */
function settle(
  editor: Editor,
  uploadId: string,
  update: ((attrs: Record<string, unknown>) => Record<string, unknown>) | null,
): void {
  if (editor.isDestroyed) return
  const { state, view } = editor
  let found: { pos: number; size: number; attrs: Record<string, unknown> } | null = null
  state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === "image" && node.attrs.uploadId === uploadId) {
      found = { pos, size: node.nodeSize, attrs: node.attrs }
      return false
    }
    return true
  })
  if (!found) return
  const { pos, size, attrs } = found as { pos: number; size: number; attrs: Record<string, unknown> }
  const tr = update ? state.tr.setNodeMarkup(pos, undefined, update(attrs)) : state.tr.delete(pos, pos + size)
  view.dispatch(tr.setMeta("addToHistory", false))
}

/**
 * Images pasted or dropped on the page upload to the branch. It must run
 * before the MDX paste: a copied file also puts its name on the clipboard as
 * text.
 */
export function createImageUpload(options: ImageUploadOptions) {
  return Extension.create<ImageUploadOptions, ImageUploadStorage>({
    name: "imageUpload",
    addOptions: () => options,
    addStorage() {
      return { getUploader: this.options.getUploader, previews: new Map(), fallbacks: new Map() }
    },
    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          key: new PluginKey("imageUpload"),
          props: {
            handlePaste: (_view, event) => {
              const files = imageFiles(event.clipboardData?.files)
              if (files.length === 0 || !canUploadImages(editor)) return false
              event.preventDefault()
              return insertImageFiles(editor, files)
            },
            handleDrop: (view, event, _slice, moved) => {
              if (moved) return false
              const files = imageFiles(event.dataTransfer?.files)
              if (files.length === 0 || !canUploadImages(editor)) return false
              event.preventDefault()
              const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
              return insertImageFiles(editor, files, position)
            },
          },
        }),
      ]
    },
  })
}
