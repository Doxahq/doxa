import {
  collectFenceLanguages,
  getLazyDocsHighlighter,
  type LazyDocsHighlighter,
} from "@doxahq/mdx-runtime/highlight-lazy";

import type {
  DocsPageHighlighting,
  DocsParserHighlighter,
} from "./docs-route-data";

/**
 * Starts creating the shared server highlighter (the themes, no grammars), so
 * the work can overlap a content request. A failure here is not reported: the
 * next caller of `loadServerPageHighlighting` creates it again and sees the
 * error.
 */
export function warmServerHighlighter(): void {
  getLazyDocsHighlighter().catch(() => undefined);
}

/**
 * Starts loading the grammars of the fences in an MDX source, without waiting.
 * The page parse later waits for the same loads.
 */
export function preloadServerHighlighterLanguages(source: string): void {
  getLazyDocsHighlighter()
    .then((highlighter) => highlighter.load(collectFenceLanguages(source)))
    .catch(() => undefined);
}

/** Page highlighting with the shared server highlighter of this isolate. */
export async function loadServerPageHighlighting(): Promise<DocsPageHighlighting> {
  return createPageHighlighting(await getLazyDocsHighlighter());
}

/**
 * Page highlighting that loads only the grammars a page uses.
 *
 * Before the parse it loads the grammars of the fences that
 * `collectFenceLanguages` finds. The scan reads lines, not the MDX tree, so
 * if the parser highlights a fence in a language that is not loaded, the
 * page is parsed again after that grammar loads. The output is then the
 * same as with the highlighter that holds every grammar.
 */
export function createPageHighlighting(
  highlighter: LazyDocsHighlighter,
  scanLanguages: (source: string) => Iterable<string> = collectFenceLanguages
): DocsPageHighlighting {
  return {
    async parse(source, parse) {
      await highlighter.load(scanLanguages(source));

      const missed = new Set<string>();
      const result = parse(trackMissedLanguages(highlighter, missed));
      if (missed.size === 0) return result;

      await highlighter.load(missed);
      return parse(highlighter.parserHighlighter);
    },
  };
}

function trackMissedLanguages(
  highlighter: LazyDocsHighlighter,
  missed: Set<string>
): DocsParserHighlighter {
  return {
    codeToHast(code, options) {
      const language = String(options.lang ?? "");
      if (!highlighter.isReady(language)) missed.add(language);
      return highlighter.parserHighlighter.codeToHast(code, options);
    },
  };
}
