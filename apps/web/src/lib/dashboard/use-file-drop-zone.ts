import { useEffect, useRef, useState, type DragEvent } from "react"

function hasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  return dataTransfer ? Array.from(dataTransfer.types).includes("Files") : false
}

/**
 * True while a person drags files anywhere over the page.
 *
 * While the hook is mounted, a file dropped outside a drop zone does nothing.
 * Without this, the browser opens the file in the tab and the page is lost.
 */
export function useWindowFileDrag(): boolean {
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    // Enter and leave fire for each element under the pointer. The depth is 0
    // only when the drag leaves the window.
    let depth = 0
    function onEnter(event: globalThis.DragEvent) {
      if (!hasFiles(event.dataTransfer)) return
      depth += 1
      setIsDragging(true)
    }
    function onLeave(event: globalThis.DragEvent) {
      if (!hasFiles(event.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setIsDragging(false)
    }
    function onOver(event: globalThis.DragEvent) {
      // A drop zone accepts the drop first. Everywhere else refuses it.
      if (!hasFiles(event.dataTransfer) || event.defaultPrevented) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none"
    }
    function onEnd(event: globalThis.DragEvent) {
      depth = 0
      setIsDragging(false)
      if (event.type === "drop" && hasFiles(event.dataTransfer)) event.preventDefault()
    }

    window.addEventListener("dragenter", onEnter)
    window.addEventListener("dragleave", onLeave)
    window.addEventListener("dragover", onOver)
    window.addEventListener("drop", onEnd)
    window.addEventListener("dragend", onEnd)
    return () => {
      window.removeEventListener("dragenter", onEnter)
      window.removeEventListener("dragleave", onLeave)
      window.removeEventListener("dragover", onOver)
      window.removeEventListener("drop", onEnd)
      window.removeEventListener("dragend", onEnd)
    }
  }, [])

  return isDragging
}

export interface FileDropZone {
  /** A file is dragged somewhere over the page. */
  isDragActive: boolean
  /** A file is dragged over this zone. */
  isOver: boolean
  zoneProps: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void
    onDragOver: (event: DragEvent<HTMLElement>) => void
    onDragLeave: (event: DragEvent<HTMLElement>) => void
    onDrop: (event: DragEvent<HTMLElement>) => void
  }
}

/** Accept one file dropped on an element. Spread `zoneProps` on the element. */
export function useFileDropZone({
  disabled = false,
  onFile,
}: {
  disabled?: boolean
  onFile: (file: File) => void
}): FileDropZone {
  const isWindowDrag = useWindowFileDrag()
  const depth = useRef(0)
  const [isOver, setIsOver] = useState(false)

  // A drag that ends outside the zone does not always send a leave event.
  useEffect(() => {
    if (isWindowDrag) return
    depth.current = 0
    setIsOver(false)
  }, [isWindowDrag])

  return {
    isDragActive: isWindowDrag && !disabled,
    isOver: isOver && !disabled,
    zoneProps: {
      onDragEnter(event) {
        if (!hasFiles(event.dataTransfer)) return
        event.preventDefault()
        depth.current += 1
        setIsOver(true)
      },
      onDragOver(event) {
        if (!hasFiles(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = disabled ? "none" : "copy"
      },
      onDragLeave(event) {
        if (!hasFiles(event.dataTransfer)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setIsOver(false)
      },
      onDrop(event) {
        if (!hasFiles(event.dataTransfer)) return
        event.preventDefault()
        depth.current = 0
        setIsOver(false)
        const file = event.dataTransfer.files[0]
        if (file && !disabled) onFile(file)
      },
    },
  }
}
