import type { RepoMapLanguage } from "./types";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, RepoMapLanguage>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "generic",
  kt: "generic",
  kts: "generic",
  scala: "generic",
  swift: "generic",
  cs: "generic",
  c: "generic",
  h: "generic",
  cc: "generic",
  cpp: "generic",
  hpp: "generic",
  php: "generic",
  rb: "generic",
  ex: "generic",
  exs: "generic",
  dart: "generic",
  lua: "generic",
};

/** Comment and string syntax for the masker. */
export interface LexicalSyntax {
  lineComments: readonly string[];
  blockComment?: { open: string; close: string; nested: boolean };
  quotes: readonly string[];
  /** Quotes where a backslash is literal, like Go raw strings. */
  rawQuotes: readonly string[];
  /** JavaScript template literals with `${...}` code inside. */
  templateLiterals: boolean;
  /** Python `"""` and `'''` strings. */
  tripleQuotes: boolean;
  /** JavaScript regular expression literals. */
  regexLiterals: boolean;
  /** Rust `r#"..."#` raw strings and `'a'` char literals beside `'a` lifetimes. */
  rustLiterals: boolean;
}

const C_LIKE: LexicalSyntax = {
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/", nested: false },
  quotes: ['"', "'"],
  rawQuotes: [],
  templateLiterals: false,
  tripleQuotes: false,
  regexLiterals: false,
  rustLiterals: false,
};

const SYNTAX: Readonly<Record<RepoMapLanguage, LexicalSyntax>> = {
  typescript: { ...C_LIKE, templateLiterals: true, regexLiterals: true },
  javascript: { ...C_LIKE, templateLiterals: true, regexLiterals: true },
  python: {
    lineComments: ["#"],
    quotes: ['"', "'"],
    rawQuotes: [],
    templateLiterals: false,
    tripleQuotes: true,
    regexLiterals: false,
    rustLiterals: false,
  },
  go: { ...C_LIKE, rawQuotes: ["`"] },
  rust: {
    lineComments: ["//"],
    blockComment: { open: "/*", close: "*/", nested: true },
    quotes: ['"'],
    rawQuotes: [],
    templateLiterals: false,
    tripleQuotes: false,
    regexLiterals: false,
    rustLiterals: true,
  },
  generic: { ...C_LIKE, quotes: ['"', "'", "`"] },
};

/** Generic files whose comments start with `#` instead of `//`. */
const HASH_COMMENT_EXTENSIONS = new Set(["rb", "ex", "exs"]);

const HASH_COMMENT_SYNTAX: LexicalSyntax = {
  ...SYNTAX.generic,
  lineComments: ["#"],
  blockComment: undefined,
};

function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The language of a source file, or null for files the map does not parse. */
export function detectLanguage(path: string): RepoMapLanguage | null {
  if (path.endsWith(".d.ts")) return null;
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}

export function syntaxFor(language: RepoMapLanguage, path: string): LexicalSyntax {
  if (language === "generic" && HASH_COMMENT_EXTENSIONS.has(extensionOf(path))) {
    return HASH_COMMENT_SYNTAX;
  }
  return SYNTAX[language];
}
