/**
 * Fallback for languages without a dedicated extractor (Java, Kotlin, C#,
 * Swift, C/C++, PHP, Ruby, ...): declaration keywords at the start of a line,
 * dotted `import`/`using` names, and quoted `#include` paths.
 */

import type { FileExtraction, RepoSymbolKind } from "../types";
import {
  collectIdentifiers,
  ImportCollector,
  LexedSource,
  SymbolCollector,
} from "./shared";

const MODIFIERS =
  "(?:(?:public|private|protected|internal|static|final|abstract|open|sealed|data|export|async|override|inline|virtual|partial|pub|readonly)\\s+)*";
const DECLARATION = new RegExp(
  `^[ \\t]*(${MODIFIERS})(class|interface|struct|enum|trait|object|record|protocol|module|def|fn|func|function|fun)\\s+([A-Za-z_][\\w]*)`,
  "gm",
);
const DOTTED_IMPORT = /^[ \t]*(?:import|using)[ \t]+(?:static[ \t]+)?([A-Za-z_][\w.]*)/gm;
const INCLUDE = /^[ \t]*#[ \t]*include[ \t]*(")/gm;

const KIND_BY_KEYWORD: Readonly<Record<string, RepoSymbolKind>> = {
  class: "class",
  struct: "class",
  record: "class",
  object: "class",
  enum: "class",
  interface: "type",
  trait: "type",
  protocol: "type",
  module: "module",
};

export function extractGeneric(lexed: LexedSource): FileExtraction {
  const symbols = new SymbolCollector();
  const imports = new ImportCollector();
  const { masked } = lexed;

  for (const match of masked.matchAll(DECLARATION)) {
    const [, modifiers, keyword, name] = match;
    const exported = !/\bprivate\b/.test(modifiers) && !name.startsWith("_");
    symbols.add(name, KIND_BY_KEYWORD[keyword] ?? "function", exported, lexed.lineAt(match.index));
  }
  for (const match of masked.matchAll(DOTTED_IMPORT)) {
    imports.add({ specifier: match[1] });
  }
  for (const match of masked.matchAll(INCLUDE)) {
    const specifier = lexed.stringAt(match.index + match[0].length - 1);
    if (specifier) imports.add({ specifier: `./${specifier}` });
  }

  return {
    symbols: symbols.list(),
    imports: imports.list(),
    identifiers: collectIdentifiers(masked),
  };
}
