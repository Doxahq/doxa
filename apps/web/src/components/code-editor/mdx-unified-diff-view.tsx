import { useEffect, useRef } from "react"
import { unifiedMergeView } from "@codemirror/merge"
import { EditorView } from "@codemirror/view"

import {
  COLLAPSE_UNCHANGED,
  labelled,
  READ_ONLY_DIFF_EXTENSIONS,
} from "~/components/code-editor/mdx-diff-extensions"

export interface MdxUnifiedDiffViewProps {
  /** The old source; empty for a new page. */
  before: string
  /** The new source; empty for a removed page. */
  after: string
  /** The screen reader name of the diff. */
  label: string
}

/**
 * A read-only diff of two MDX sources in one column, like a pull request:
 * removed lines in red above the green lines that replace them.
 */
export default function MdxUnifiedDiffView({ before, after, label }: MdxUnifiedDiffViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      doc: after,
      extensions: [
        ...READ_ONLY_DIFF_EXTENSIONS,
        labelled(label),
        unifiedMergeView({
          original: before,
          mergeControls: false,
          highlightChanges: true,
          gutter: true,
          syntaxHighlightDeletions: true,
          collapseUnchanged: COLLAPSE_UNCHANGED,
        }),
      ],
    })
    return () => view.destroy()
  }, [before, after, label])

  return <div ref={hostRef} className="h-full min-h-0 overflow-auto" data-testid="mdx-unified-diff-view" />
}
