import type { RuntimeMdxParseOptions } from "@doxahq/mdx-runtime";

export type ProseHighlighter = NonNullable<RuntimeMdxParseOptions["highlighter"]>;

let highlighterPromise: Promise<ProseHighlighter> | null = null;

/**
 * Loads the Shiki highlighter used for documentation code fences.
 *
 * The grammars and themes are large, so the module is imported on demand and
 * the instance is shared afterwards. Pass the result to `parseRuntimeMdx` as
 * `highlighter` to get the same highlighted markup the published docs render.
 */
export function loadProseHighlighter(): Promise<ProseHighlighter> {
  highlighterPromise ??= import("@doxahq/mdx-runtime/highlight").then(
    ({ getDocsHighlighter }) => getDocsHighlighter(),
  );
  return highlighterPromise;
}
