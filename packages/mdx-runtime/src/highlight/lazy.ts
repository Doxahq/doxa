/**
 * The browser highlighter. It loads each grammar on demand, so a page pays only
 * for the languages its code blocks use.
 *
 * `getDocsHighlighter` stays the renderer's highlighter: it is synchronous and
 * carries every grammar at once. This module gives the same output for every
 * language it reports as ready. The parity tests compare the two for each
 * supported language.
 *
 * Do not import `./grammars` here. That module imports every grammar
 * statically, and the point of this entry is to leave them out.
 */
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import { resolveFenceLanguage } from "./fence-languages";

export { collectFenceLanguages, resolveFenceLanguage } from "./fence-languages";

type GrammarModule = { default: LanguageRegistration[] };

/**
 * One dynamic import per grammar of the sync highlighter, keyed by the grammar
 * name that `resolveFenceLanguage` returns. A bundler puts each one in its own
 * chunk. Each module also brings the grammars it embeds, as in `grammars.ts`.
 */
export const DOCS_GRAMMAR_LOADERS = {
  bash: () => import("@shikijs/langs/bash"),
  json: () => import("@shikijs/langs/json"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  css: () => import("@shikijs/langs/css"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  sql: () => import("@shikijs/langs/sql"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  diff: () => import("@shikijs/langs/diff"),
  http: () => import("@shikijs/langs/http"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  toml: () => import("@shikijs/langs/toml"),
  graphql: () => import("@shikijs/langs/graphql"),
  xml: () => import("@shikijs/langs/xml"),
  scss: () => import("@shikijs/langs/scss"),
} satisfies Record<string, () => Promise<GrammarModule>>;

export type DocsGrammarName = keyof typeof DOCS_GRAMMAR_LOADERS;

/**
 * Grammars that another grammar includes without declaring them as embedded
 * (Shiki's `embeddedLangsLazy`). The sync highlighter always has them, so a
 * Markdown fence inside a Markdown block is colored there. To give the same
 * output, a grammar becomes ready only after its companions are loaded.
 *
 * A test reads every grammar's includes and checks this list, so a Shiki
 * update that adds an include fails the test instead of changing colors.
 */
export const DOCS_GRAMMAR_COMPANIONS: Readonly<
  Partial<Record<DocsGrammarName, readonly DocsGrammarName[]>>
> = {
  markdown: [
    "bash",
    "css",
    "diff",
    "dockerfile",
    "go",
    "html",
    "java",
    "json",
    "python",
    "rust",
    "scss",
    "sql",
    "typescript",
    "tsx",
    "xml",
    "yaml",
  ],
};

/** Languages Shiki highlights without a grammar. */
const PLAIN_LANGUAGES: ReadonlySet<string> = new Set(["text"]);

type CodeToHast = HighlighterCore["codeToHast"];

export interface LazyDocsHighlighter {
  /**
   * The Shiki instance. Use it only for a language that `isReady` accepts:
   * for any other language it throws, or colors less than the renderer does.
   */
  readonly shiki: HighlighterCore;
  /**
   * True when code in this language (a grammar name or a fence alias) is
   * highlighted now with the same output as the renderer's highlighter.
   */
  isReady(language: string): boolean;
  /**
   * Loads the grammars for these languages (grammar names or fence aliases).
   * Unknown names are skipped. It never rejects: a grammar that fails to load
   * stays not ready, and a later call tries it again.
   */
  load(languages: Iterable<string>): Promise<void>;
  /**
   * A highlighter for `parseRuntimeMdx`. A fence whose grammar is not ready
   * yet gets an empty tree, and the parser then draws it plain, as it does
   * when no highlighter is given. Load the grammars and parse again to color it.
   */
  readonly parserHighlighter: Pick<HighlighterCore, "codeToHast">;
}

let sharedHighlighter: Promise<LazyDocsHighlighter> | null = null;

/** The highlighter shared by the whole page. Loaded grammars stay loaded. */
export function getLazyDocsHighlighter(): Promise<LazyDocsHighlighter> {
  sharedHighlighter ??= createLazyDocsHighlighter().catch((error: unknown) => {
    // A failed theme download must not stick for the rest of the session.
    sharedHighlighter = null;
    throw error;
  });
  return sharedHighlighter;
}

/** A new highlighter with the docs themes and no grammars. */
export async function createLazyDocsHighlighter(): Promise<LazyDocsHighlighter> {
  const shiki = await createHighlighterCore({
    themes: [
      import("@shikijs/themes/github-light"),
      import("@shikijs/themes/github-dark"),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });

  const ready = new Set<string>(PLAIN_LANGUAGES);
  const loading = new Map<DocsGrammarName, Promise<void>>();

  function loadGrammar(grammar: DocsGrammarName): Promise<void> {
    if (ready.has(grammar)) return Promise.resolve();
    let pending = loading.get(grammar);
    if (!pending) {
      const companions = DOCS_GRAMMAR_COMPANIONS[grammar] ?? [];
      pending = Promise.all([
        DOCS_GRAMMAR_LOADERS[grammar](),
        Promise.all(companions.map(loadGrammar)),
      ])
        .then(async ([module]) => {
          await shiki.loadLanguage(...module.default);
          ready.add(grammar);
        })
        .finally(() => loading.delete(grammar));
      loading.set(grammar, pending);
    }
    return pending;
  }

  const isReady = (language: string): boolean => {
    const grammar = resolveFenceLanguage(language);
    return grammar !== null && ready.has(grammar);
  };

  const codeToHast: CodeToHast = (code, options) =>
    isReady(String(options.lang ?? ""))
      ? shiki.codeToHast(code, options)
      : { type: "root", children: [] };

  return {
    shiki,
    isReady,
    async load(languages) {
      const grammars = new Set<DocsGrammarName>();
      for (const language of languages) {
        const grammar = resolveFenceLanguage(language);
        if (grammar && isDocsGrammar(grammar)) grammars.add(grammar);
      }
      await Promise.allSettled([...grammars].map(loadGrammar));
    },
    parserHighlighter: { codeToHast },
  };
}

function isDocsGrammar(name: string): name is DocsGrammarName {
  return Object.hasOwn(DOCS_GRAMMAR_LOADERS, name);
}
