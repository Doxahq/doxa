import type { LazyDocsHighlighter } from "@doxahq/mdx-runtime/highlight-lazy"

export type { LazyDocsHighlighter }

/**
 * The editor's Shiki instance: the published site's themes and grammars, with
 * each grammar loaded only when a page uses it. Load the grammars of a page
 * with `load`, and highlight only the languages that `isReady` accepts. The
 * colors are the same as on the published site.
 *
 * The module itself loads on demand, after the editor opens.
 */
export function loadDocsHighlighter(): Promise<LazyDocsHighlighter> {
  return import("@doxahq/mdx-runtime/highlight-lazy")
    .then(({ getLazyDocsHighlighter }) => getLazyDocsHighlighter())
    .then((highlighter) => {
      loadedHighlighter = highlighter
      return highlighter
    })
}

let loadedHighlighter: LazyDocsHighlighter | null = null

/**
 * The highlighter, if it has loaded already. A view that mounts after that
 * can draw colored code on its first render instead of plain code first.
 */
export function peekDocsHighlighter(): LazyDocsHighlighter | null {
  return loadedHighlighter
}
