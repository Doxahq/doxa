import { useEffect, useImperativeHandle, useRef, type Ref } from "react"
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import { createBaseExtensions } from "~/components/code-editor/base-extensions"

export interface CodeEditorHandle {
  focus: () => void
  /** The current editor state, or null before the view mounts. */
  getState: () => EditorState | null
  /** Selects a range, scrolls it into view, and focuses the editor. */
  revealRange: (from: number, to?: number) => void
}

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  readOnly?: boolean
  /**
   * The language extension. Pass a stable value, a module constant or a
   * memoized one: a new identity reconfigures the editor.
   */
  language: Extension
  ariaLabel?: string
  ref?: Ref<CodeEditorHandle>
}

/**
 * A controlled CodeMirror 6 editor.
 *
 * The view is created once. Later prop changes reach it through effects and
 * compartments, so typing does no React work per keystroke and the cursor
 * never jumps.
 */
export function CodeEditor({
  value,
  onChange,
  onSave,
  readOnly = false,
  language,
  ariaLabel,
  ref,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  // Callbacks change on every render. Keeping them in refs lets the editor be
  // created once, which is what keeps typing free of React work per keystroke.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      getState: () => viewRef.current?.state ?? null,
      revealRange: (from, to = from) => {
        const view = viewRef.current
        if (!view) return
        const length = view.state.doc.length
        const range = EditorSelection.range(Math.min(from, length), Math.min(to, length))
        view.dispatch({
          selection: EditorSelection.create([range]),
          effects: EditorView.scrollIntoView(range, { y: "center" }),
        })
        view.focus()
      },
    }),
    [],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: createBaseExtensions({
          language: languageCompartment.current.of(language),
          readOnly: readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
          onSave: () => onSaveRef.current(),
          onChange: (next) => onChangeRef.current(next),
          ariaLabel,
        }),
      }),
    })

    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The view is created once; later prop changes are applied by the effects
    // below rather than by rebuilding the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Replace the document only when the incoming value differs, so typing does
  // not fight the controlled value and the cursor stays where it was.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: languageCompartment.current.reconfigure(language) })
  }, [language])

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />
}
