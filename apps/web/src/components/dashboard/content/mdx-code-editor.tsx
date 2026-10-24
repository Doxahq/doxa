import { useEffect, useRef } from "react"

import { CodeEditor, type CodeEditorHandle } from "~/components/code-editor/code-editor"
import { mdxEditorExtensions } from "~/components/code-editor/languages/mdx"

/** A request to show an offset of the source. A new object reveals again. */
export interface SourceReveal {
  offset: number
}

interface MdxCodeEditorProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  readOnly?: boolean
  /** Selects and scrolls to an offset, for example the line of an MDX issue. */
  reveal?: SourceReveal | null
  onRevealed?: () => void
}

/**
 * The page source editor: the shared code editor with the MDX language and the
 * writing theme. The language slot takes any stable extension, so the theme
 * rides along with the language.
 */
export default function MdxCodeEditor({ reveal, onRevealed, ...props }: MdxCodeEditorProps) {
  const editor = useRef<CodeEditorHandle>(null)
  const onRevealedRef = useRef(onRevealed)
  onRevealedRef.current = onRevealed

  // Child effects run first, so the editor view exists here even on the
  // mount that a reveal from Write mode causes.
  useEffect(() => {
    if (!reveal) return
    editor.current?.revealRange(reveal.offset)
    onRevealedRef.current?.()
  }, [reveal])

  return <CodeEditor {...props} ref={editor} language={mdxEditorExtensions} />
}
