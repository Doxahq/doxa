import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react"

import type { CodeEditorProps } from "~/components/code-editor/code-editor"
import { cn } from "~/lib/utils"

/**
 * The code editor for places that open it on demand, like the Write editor's
 * "Edit MDX" dialog and the diagram source panel.
 *
 * CodeMirror and its grammars are large, and most visits to those places
 * never open the editor. This module imports neither, so a module that uses
 * it does not load them. Call `preloadCodeEditor` when the user points at
 * the control that opens the editor, so the code is there before the click.
 */

/** The language of a lazily loaded editor. Each one loads with the editor. */
export type LazyCodeEditorLanguage = "mdx" | "plain"

export type LazyCodeEditorProps = Omit<CodeEditorProps, "language"> & {
  language: LazyCodeEditorLanguage
}

type LoadedEditor = ComponentType<Omit<CodeEditorProps, "language">>

/** A stable empty extension list: a new identity would reconfigure the editor. */
const PLAIN_TEXT: never[] = []

const LOADERS: Record<LazyCodeEditorLanguage, () => Promise<{ default: LoadedEditor }>> = {
  mdx: () =>
    Promise.all([import("~/components/code-editor/code-editor"), import("~/components/code-editor/languages/mdx")]).then(
      ([{ CodeEditor }, { mdxEditorExtensions }]) => ({
        default: (props) => <CodeEditor {...props} language={mdxEditorExtensions} />,
      }),
    ),
  plain: () =>
    import("~/components/code-editor/code-editor").then(({ CodeEditor }) => ({
      default: (props) => <CodeEditor {...props} language={PLAIN_TEXT} />,
    })),
}

/** The editor's background, so the empty box matches the editor that replaces it. */
const BACKGROUNDS: Record<LazyCodeEditorLanguage, string> = {
  mdx: "bg-editor",
  plain: "",
}

const loads = new Map<LazyCodeEditorLanguage, Promise<{ default: LoadedEditor }>>()
const editors = new Map<LazyCodeEditorLanguage, LazyExoticComponent<LoadedEditor>>()

/** Loads the editor and the language once. A failed load is tried again on the next call. */
function loadCodeEditor(language: LazyCodeEditorLanguage): Promise<{ default: LoadedEditor }> {
  let load = loads.get(language)
  if (!load) {
    load = LOADERS[language]()
    load.catch(() => {
      loads.delete(language)
      editors.delete(language)
    })
    loads.set(language, load)
  }
  return load
}

/** Starts loading the editor and the language. It is safe to call on every hover. */
export function preloadCodeEditor(language: LazyCodeEditorLanguage): void {
  // A failure shows when the editor renders. Here it only means no head start.
  loadCodeEditor(language).catch(() => undefined)
}

function editorFor(language: LazyCodeEditorLanguage): LazyExoticComponent<LoadedEditor> {
  let editor = editors.get(language)
  if (!editor) {
    editor = lazy(() => loadCodeEditor(language))
    editors.set(language, editor)
  }
  return editor
}

/**
 * The shared code editor, loaded on first use. Until the code arrives, it
 * holds the editor's place with an empty box of the same size and color, so
 * the dialog or panel around it does not change. It is not a loading state:
 * after `preloadCodeEditor` the box is not seen.
 */
export function LazyCodeEditor({ language, ...props }: LazyCodeEditorProps) {
  const Editor = editorFor(language)
  return (
    <Suspense fallback={<CodeEditorPlaceholder className={BACKGROUNDS[language]} />}>
      <Editor {...props} />
    </Suspense>
  )
}

/** The size and background of the editor's host, with nothing in it. */
function CodeEditorPlaceholder({ className }: { className: string }) {
  return (
    <div aria-hidden="true" data-code-editor-placeholder="" className={cn("h-full min-h-0 overflow-hidden", className)} />
  )
}
