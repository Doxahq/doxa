import { useEffect, useRef } from "react"
import { MergeView } from "@codemirror/merge"

import {
  COLLAPSE_UNCHANGED,
  labelled,
  READ_ONLY_DIFF_EXTENSIONS,
} from "~/components/code-editor/mdx-diff-extensions"

export interface MdxMergeViewProps {
  /** The main source; empty for an added page. */
  before: string
  /** The branch source; empty for a deleted page. */
  after: string
  /** The screen reader names of the two sides. */
  labels?: { before: string; after: string }
}

/**
 * A read-only side-by-side diff of two MDX sources, with the editor theme.
 * Long unchanged stretches collapse; a click expands them.
 */
export default function MdxMergeView({
  before,
  after,
  labels = { before: "Main source", after: "Branch source" },
}: MdxMergeViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new MergeView({
      parent: host,
      a: { doc: before, extensions: [...READ_ONLY_DIFF_EXTENSIONS, labelled(labels.before)] },
      b: { doc: after, extensions: [...READ_ONLY_DIFF_EXTENSIONS, labelled(labels.after)] },
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: COLLAPSE_UNCHANGED,
    })
    return () => view.destroy()
  }, [before, after, labels.before, labels.after])

  return <div ref={hostRef} className="h-full min-h-0 overflow-auto" data-testid="mdx-merge-view" />
}
