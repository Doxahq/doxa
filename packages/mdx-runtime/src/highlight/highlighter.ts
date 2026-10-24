import { createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import { DOCS_LANGUAGES, DOCS_THEMES } from "./grammars";

let cachedHighlighter: HighlighterCore | null = null;

/**
 * The JavaScript regex engine replaces the Oniguruma WASM engine.
 * Cloudflare Workers cannot load the WASM module.
 */
export function getDocsHighlighter(): HighlighterCore {
  cachedHighlighter ??= createHighlighterCoreSync({
    themes: DOCS_THEMES,
    langs: DOCS_LANGUAGES,
    engine: createJavaScriptRegexEngine(),
  });
  return cachedHighlighter;
}
