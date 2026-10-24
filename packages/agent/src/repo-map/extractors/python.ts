/**
 * Python declarations: top-level functions and classes, public methods,
 * `__all__`, imports, and route decorators (FastAPI, Flask, and similar).
 * Decorators sit on their own lines, so a decorated `def` is still found.
 */

import type { FileExtraction } from "../types";
import {
  collectIdentifiers,
  ImportCollector,
  LexedSource,
  routeLabel,
  SymbolCollector,
} from "./shared";

const DEFINITION = /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/gm;
const ROUTE_DECORATOR =
  /^[ \t]*@[\w.]*?\.(get|post|put|patch|delete|options|head|route|api_route|websocket)\s*\(\s*(?:path\s*=\s*)?[rbfu]*(["'])/gm;
const ALL_ASSIGNMENT = /^__all__\s*(?::[^=\n]*)?\+?=\s*[[(]/gm;
const IMPORT = /^[ \t]*import[ \t]+([^\n;]+)/gm;
const FROM_IMPORT = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)/gm;

interface ClassScope {
  name: string;
  offset: number;
  exported: boolean;
  /** Indent of the class body, set by its first method. */
  bodyIndent?: number;
}

/** A line that starts at column 0 ends a top-level class body. */
const TOP_LEVEL_LINE = /\n[^\s]/;

export function extractPython(lexed: LexedSource): FileExtraction {
  const symbols = new SymbolCollector();
  const imports = new ImportCollector();
  const { masked } = lexed;
  const declaredAll = readDunderAll(lexed);
  const isPublic = (name: string) => declaredAll ? declaredAll.has(name) : !name.startsWith("_");

  let currentClass: ClassScope | null = null;
  for (const match of masked.matchAll(DEFINITION)) {
    const indent = match[1].replace(/\t/g, "    ").length;
    const [, , keyword, name] = match;
    const line = lexed.lineAt(match.index);
    if (currentClass && TOP_LEVEL_LINE.test(masked.slice(currentClass.offset, match.index))) {
      currentClass = null;
    }

    if (indent === 0) {
      const exported = isPublic(name);
      symbols.add(name, keyword === "class" ? "class" : "function", exported, line);
      currentClass = keyword === "class" ? { name, offset: match.index, exported } : null;
      continue;
    }
    if (!currentClass || keyword !== "def") continue;
    currentClass.bodyIndent ??= indent;
    // Only direct methods of a top-level class; nested helpers stay private.
    if (indent === currentClass.bodyIndent) {
      symbols.add(
        `${currentClass.name}.${name}`,
        "method",
        currentClass.exported && !name.startsWith("_"),
        line,
      );
    }
  }

  for (const match of masked.matchAll(ROUTE_DECORATOR)) {
    const quoteIndex = match.index + match[0].length - 1;
    const method = match[1] === "route" || match[1] === "api_route" || match[1] === "websocket"
      ? null
      : match[1];
    const label = routeLabel(method, lexed.stringAt(quoteIndex));
    if (label) symbols.add(label, "route", true, lexed.lineAt(match.index));
  }

  for (const match of masked.matchAll(IMPORT)) {
    for (const part of match[1].split(",")) {
      const module = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (module && /^[\w.]+$/.test(module)) imports.add({ specifier: module });
    }
  }
  for (const match of masked.matchAll(FROM_IMPORT)) {
    const names = match[2]
      .replace(/[()\\]/g, " ")
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
      .filter((name) => /^\w+$/.test(name));
    imports.add({ specifier: match[1], names });
  }

  return {
    symbols: symbols.list(),
    imports: imports.list(),
    identifiers: collectIdentifiers(masked),
  };
}

/** Names listed in a literal `__all__`, or null when the module has none. */
function readDunderAll(lexed: LexedSource): Set<string> | null {
  let names: Set<string> | null = null;
  for (const match of lexed.masked.matchAll(ALL_ASSIGNMENT)) {
    names ??= new Set();
    const open = match.index + match[0].length - 1;
    const close = lexed.masked.indexOf(lexed.masked[open] === "[" ? "]" : ")", open);
    if (close < 0) continue;
    for (let index = open; index < close; index++) {
      const char = lexed.masked[index];
      if (char !== '"' && char !== "'") continue;
      const value = lexed.stringAt(index);
      if (value !== null) names.add(value);
      index = lexed.masked.indexOf(char, index + 1);
      if (index < 0) break;
    }
  }
  return names;
}
