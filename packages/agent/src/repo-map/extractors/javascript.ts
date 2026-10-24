/**
 * TypeScript and JavaScript declarations: ES exports, re-exports, default
 * exports, top-level declarations, CommonJS exports, imports, and
 * Express/Hono/Fastify-style route registrations.
 */

import type { FileExtraction } from "../types";
import {
  collectIdentifiers,
  ImportCollector,
  LexedSource,
  routeLabel,
  SymbolCollector,
} from "./shared";

const NAME = "[A-Za-z_$][\\w$]*";
/** A masked string literal: its quotes survive, its body is blank. */
const STRING = "([\"'])[^\"'\\n]*\\";

const EXPORT_FUNCTION = new RegExp(
  `\\bexport\\s+(default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${NAME})?`,
  "g",
);
const EXPORT_CLASS = new RegExp(
  `\\bexport\\s+(default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${NAME})?`,
  "g",
);
const EXPORT_VARIABLE = new RegExp(
  `\\bexport\\s+(?:declare\\s+)?(?:const|let|var)\\s+(?!enum\\b)(${NAME})`,
  "g",
);
const EXPORT_TYPE = new RegExp(
  `\\bexport\\s+(?:declare\\s+)?(?:const\\s+)?(type|interface|enum|namespace|module)\\s+(${NAME})`,
  "g",
);
const EXPORT_DEFAULT_EXPRESSION = new RegExp(
  `\\bexport\\s+default\\s+(?!(?:async\\s+)?function\\b|(?:abstract\\s+)?class\\b)(${NAME})?`,
  "g",
);
const EXPORT_LIST = new RegExp(
  `\\bexport\\s+(?:type\\s+)?\\{([^}]*)\\}(?:\\s*from\\s*${STRING}2)?`,
  "g",
);
const EXPORT_STAR = new RegExp(
  `\\bexport\\s+(?:type\\s+)?\\*\\s*(?:as\\s+(${NAME})\\s*)?from\\s*${STRING}2`,
  "g",
);
const TOP_LEVEL_DECLARATION = new RegExp(
  `^(?:declare\\s+)?(?:(?:async\\s+)?function\\s*\\*?\\s*|(?:abstract\\s+)?class\\s+|(type|interface|enum)\\s+)(${NAME})`,
  "gm",
);
const TOP_LEVEL_VARIABLE = new RegExp(`^(?:const|let|var)\\s+(${NAME})`, "gm");
const COMMONJS_EXPORT = new RegExp(`^[ \\t]*(?:module\\.)?exports\\.(${NAME})\\s*=(?!=)`, "gm");
const COMMONJS_DEFAULT = /^[ \t]*module\.exports\s*=(?!=)/gm;
const IMPORT_STATEMENT = new RegExp(
  `\\bimport\\s+(?:type\\s+)?(?:[\\w$*{}\\s,]+?\\s+from\\s*)?${STRING}1`,
  "g",
);
const DYNAMIC_IMPORT = new RegExp(`\\b(?:import|require)\\s*\\(\\s*${STRING}1\\s*\\)`, "g");
const ROUTE_CALL = new RegExp(
  `\\b(?:app|router|server|api|route|routes|hono|fastify|r)\\s*\\.\\s*(get|post|put|patch|delete|options|head|all)\\s*\\(\\s*([\"'\`])`,
  "gi",
);
/** `= (args) =>`, `= async x =>`, or `= function` after a variable name. */
const FUNCTION_INITIALIZER =
  /^\s*(?::[^=;]*)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=;]*)?=>|[A-Za-z_$][\w$]*\s*=>)/;

export function extractJavaScript(lexed: LexedSource): FileExtraction {
  const symbols = new SymbolCollector();
  const imports = new ImportCollector();
  // Local declarations first, so `export { a }` and `export default A` can mark them.
  collectTopLevelDeclarations(lexed, symbols);
  collectExports(lexed, symbols, imports);
  collectImports(lexed, imports);
  collectRoutes(lexed, symbols);
  return {
    symbols: symbols.list(),
    imports: imports.list(),
    identifiers: collectIdentifiers(lexed.masked),
  };
}

function collectTopLevelDeclarations(lexed: LexedSource, symbols: SymbolCollector): void {
  const { masked } = lexed;
  for (const match of masked.matchAll(TOP_LEVEL_DECLARATION)) {
    if (lexed.braceDepthAt(match.index) > 0) continue;
    const kind = match[1] ? "type" : /\bclass\s/.test(match[0]) ? "class" : "function";
    symbols.add(match[2], kind, false, lexed.lineAt(match.index));
  }
  for (const match of masked.matchAll(TOP_LEVEL_VARIABLE)) {
    if (lexed.braceDepthAt(match.index) > 0) continue;
    const rest = masked.slice(match.index + match[0].length, match.index + match[0].length + 200);
    if (FUNCTION_INITIALIZER.test(rest)) {
      symbols.add(match[1], "function", false, lexed.lineAt(match.index));
    }
  }
}

function collectExports(lexed: LexedSource, symbols: SymbolCollector, imports: ImportCollector): void {
  const { masked } = lexed;
  for (const match of masked.matchAll(EXPORT_FUNCTION)) {
    symbols.add(match[2] ?? "default", "function", true, lexed.lineAt(match.index));
  }
  for (const match of masked.matchAll(EXPORT_CLASS)) {
    symbols.add(match[2] ?? "default", "class", true, lexed.lineAt(match.index));
  }
  for (const match of masked.matchAll(EXPORT_VARIABLE)) {
    const rest = masked.slice(match.index + match[0].length, match.index + match[0].length + 200);
    const kind = FUNCTION_INITIALIZER.test(rest) ? "function" : "const";
    symbols.add(match[1], kind, true, lexed.lineAt(match.index));
  }
  for (const match of masked.matchAll(EXPORT_TYPE)) {
    const kind = match[1] === "namespace" || match[1] === "module" ? "module" : "type";
    symbols.add(match[2], kind, true, lexed.lineAt(match.index));
  }
  for (const match of masked.matchAll(EXPORT_DEFAULT_EXPRESSION)) {
    const name = match[1];
    const isReference = name !== undefined && /^\s*(?:;|$)/m.test(
      masked.slice(match.index + match[0].length, match.index + match[0].length + 80),
    );
    if (!(isReference && symbols.markExported(name))) {
      symbols.add("default", "const", true, lexed.lineAt(match.index));
    }
  }

  for (const match of masked.matchAll(EXPORT_LIST)) {
    const line = lexed.lineAt(match.index);
    const quoteIndex = match[2] ? openingQuote(match, match[2], match[0].indexOf("}")) : -1;
    const source = quoteIndex >= 0 ? lexed.stringAt(quoteIndex) : null;
    for (const entry of parseExportList(match[1])) {
      if (source) {
        symbols.add(entry.exported, "reexport", true, line);
      } else if (!symbols.markExported(entry.local)) {
        symbols.add(entry.exported, "const", true, line);
      }
    }
    if (source) imports.add({ specifier: source });
  }
  for (const match of masked.matchAll(EXPORT_STAR)) {
    const source = lexed.stringAt(openingQuote(match, match[2]));
    if (!source) continue;
    symbols.add(match[1] ?? `* from ${source}`, "reexport", true, lexed.lineAt(match.index));
    imports.add({ specifier: source });
  }

  for (const match of masked.matchAll(COMMONJS_EXPORT)) {
    if (!symbols.markExported(match[1])) {
      symbols.add(match[1], "const", true, lexed.lineAt(match.index));
    }
  }
  for (const match of masked.matchAll(COMMONJS_DEFAULT)) {
    symbols.add("default", "const", true, lexed.lineAt(match.index));
  }
}

function collectImports(lexed: LexedSource, imports: ImportCollector): void {
  const { masked } = lexed;
  for (const pattern of [IMPORT_STATEMENT, DYNAMIC_IMPORT]) {
    for (const match of masked.matchAll(pattern)) {
      const specifier = lexed.stringAt(openingQuote(match, match[1]));
      if (specifier) imports.add({ specifier });
    }
  }
}

function collectRoutes(lexed: LexedSource, symbols: SymbolCollector): void {
  for (const match of lexed.masked.matchAll(ROUTE_CALL)) {
    const quoteIndex = match.index + match[0].length - 1;
    const label = routeLabel(match[1], lexed.stringAt(quoteIndex));
    if (label) symbols.add(label, "route", true, lexed.lineAt(match.index));
  }
}

/** Offset of the first `quote` in a match, searching from `from` inside it. */
function openingQuote(match: RegExpMatchArray, quote: string, from = 0): number {
  return (match.index ?? 0) + match[0].indexOf(quote, from);
}

interface ExportListEntry {
  local: string;
  exported: string;
}

/** Parses `a, b as c, type D, default as E` from an export list. */
function parseExportList(body: string): ExportListEntry[] {
  return body
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part.length > 0)
    .flatMap((part) => {
      const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
      return match ? [{ local: match[1], exported: match[2] ?? match[1] }] : [];
    });
}
