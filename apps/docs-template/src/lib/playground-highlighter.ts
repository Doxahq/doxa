import { loadProseHighlighter, type ProseHighlighter } from "@doxahq/docs-prose";

export type PlaygroundHighlighter = ProseHighlighter;

/**
 * The API playground highlights request and response samples with the same
 * Shiki instance the page content uses, so a sample looks identical whether it
 * came from the page or from a live request.
 */
export function loadPlaygroundHighlighter(): Promise<PlaygroundHighlighter> {
  return loadProseHighlighter();
}
