export const FENCE_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ["bash", "bash"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["console", "bash"],
  ["shellscript", "bash"],
  ["json", "json"],
  ["jsonc", "json"],
  ["json5", "json"],
  ["typescript", "typescript"],
  ["ts", "typescript"],
  ["js", "typescript"],
  ["javascript", "typescript"],
  ["mjs", "typescript"],
  ["cjs", "typescript"],
  ["tsx", "tsx"],
  ["jsx", "jsx"],
  ["css", "css"],
  ["scss", "scss"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["mdx", "markdown"],
  ["text", "text"],
  ["txt", "text"],
  ["plaintext", "text"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["python", "python"],
  ["py", "python"],
  ["go", "go"],
  ["golang", "go"],
  ["html", "html"],
  ["htm", "html"],
  ["sql", "sql"],
  ["rust", "rust"],
  ["rs", "rust"],
  ["java", "java"],
  ["diff", "diff"],
  ["http", "http"],
  ["dockerfile", "dockerfile"],
  ["docker", "dockerfile"],
  ["toml", "toml"],
  ["graphql", "graphql"],
  ["gql", "graphql"],
  ["xml", "xml"],
]);

export function resolveFenceLanguage(language: string): string | null {
  const normalizedLanguage = language.trim().toLowerCase();
  return FENCE_LANGUAGES.get(normalizedLanguage) ?? null;
}

/**
 * A fence opener. Before the fence there can be indent (inside JSX), quote
 * markers (`>`) and list markers (`-`, `*`, `+`, `1.`). Then come three or
 * more backticks or tildes and the info string. The first word of the info
 * string is the language, as in mdast.
 */
const FENCE_OPENER_PATTERN =
  /^[ \t]*(?:(?:[>*+-]|\d{1,9}[.)])[ \t]*)*(?:`{3,}|~{3,})[ \t]*([^\s`]+)/gm;

/**
 * The grammar names of the fenced code blocks in an MDX source, in the order
 * they first appear. A fence with an unknown language is left out.
 *
 * The scan reads lines, not the MDX tree, so it is fast enough to run on each
 * edit. It can find a fence that the parser does not see as one, for example
 * inside a JavaScript string. That only loads a grammar the page does not use.
 */
export function collectFenceLanguages(source: string): string[] {
  const languages = new Set<string>();
  for (const match of source.matchAll(FENCE_OPENER_PATTERN)) {
    const language = resolveFenceLanguage(match[1] ?? "");
    if (language) languages.add(language);
  }
  return [...languages];
}
