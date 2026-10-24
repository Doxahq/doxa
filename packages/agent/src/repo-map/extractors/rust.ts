/**
 * Rust declarations: items with their `pub` visibility, public methods of
 * inherent `impl` blocks (as `Type.method`), `mod` declarations, `use` and
 * `pub use` paths, exported macros, and actix/axum routes.
 * `pub(crate)` and narrower visibility count as not exported.
 */

import type { FileExtraction, RepoSymbolKind } from "../types";
import {
  collectIdentifiers,
  ImportCollector,
  LexedSource,
  routeLabel,
  SymbolCollector,
} from "./shared";

const VISIBILITY = "(pub(?:[ \\t]*\\([^)]*\\))?[ \\t]+)?";
const FUNCTION = new RegExp(
  `^[ \\t]*${VISIBILITY}(?:(?:default|const|async|unsafe|extern(?:[ \\t]+"[^"\\n]*")?)[ \\t]+)*fn[ \\t]+([A-Za-z_]\\w*)`,
  "gm",
);
const ITEM = new RegExp(
  `^[ \\t]*${VISIBILITY}(struct|enum|union|trait|type|const|static|mod)[ \\t]+(?:mut[ \\t]+)?([A-Za-z_]\\w*)`,
  "gm",
);
const IMPL = /^[ \t]*impl\b(?:[ \t]*<[^{]*?>)?[ \t]*([^{;]*?)[ \t]*(?:where\b[^{]*)?\{/gm;
const USE = new RegExp(`^[ \\t]*${VISIBILITY}use[ \\t]+([^;]+);`, "gm");
const MACRO = /^([ \t]*#\[macro_export\][ \t\n]*)?[ \t]*macro_rules![ \t]*([A-Za-z_]\w*)/gm;
const ATTRIBUTE_ROUTE = /#\[(get|post|put|patch|delete|head|options|route)[ \t]*\(\s*(")/g;
const AXUM_ROUTE = /\.route[ \t]*\(\s*(")/g;

interface ImplScope {
  typeName: string;
  start: number;
  end: number;
  isTraitImpl: boolean;
}

export function extractRust(lexed: LexedSource): FileExtraction {
  const symbols = new SymbolCollector();
  const imports = new ImportCollector();
  const { masked } = lexed;
  const impls = collectImpls(lexed);

  for (const match of masked.matchAll(FUNCTION)) {
    const [, visibility, name] = match;
    const line = lexed.lineAt(match.index);
    const exported = isPublic(visibility);
    if (lexed.braceDepthAt(match.index) === 0) {
      symbols.add(name, "function", exported, line);
      continue;
    }
    const scope = impls.find((impl) => impl.start < match.index && match.index < impl.end);
    if (scope && !scope.isTraitImpl && exported) {
      symbols.add(`${scope.typeName}.${name}`, "method", true, line);
    }
  }

  for (const match of masked.matchAll(ITEM)) {
    if (lexed.braceDepthAt(match.index) > 0) continue;
    const [, visibility, keyword, name] = match;
    const line = lexed.lineAt(match.index);
    symbols.add(name, itemKind(keyword), isPublic(visibility), line);
    const declaration = masked.slice(match.index + match[0].length).match(/^\s*([;{])/);
    if (keyword === "mod" && declaration?.[1] === ";") {
      imports.add({ specifier: name, kind: "module-declaration" });
    }
  }

  for (const match of masked.matchAll(USE)) {
    const [, visibility, tree] = match;
    const line = lexed.lineAt(match.index);
    for (const path of flattenUseTree(normalizeUseTree(tree))) {
      imports.add({ specifier: path.path });
      if (isPublic(visibility) && path.exportedName !== "*") {
        symbols.add(path.exportedName, "reexport", true, line);
      }
    }
  }

  for (const match of masked.matchAll(MACRO)) {
    symbols.add(match[2], "macro", Boolean(match[1]), lexed.lineAt(match.index));
  }

  for (const match of masked.matchAll(ATTRIBUTE_ROUTE)) {
    const method = match[1] === "route" ? null : match[1];
    const label = routeLabel(method, lexed.stringAt(match.index + match[0].length - 1));
    if (label) symbols.add(label, "route", true, lexed.lineAt(match.index));
  }
  for (const match of masked.matchAll(AXUM_ROUTE)) {
    const label = routeLabel(null, lexed.stringAt(match.index + match[0].length - 1));
    if (label) symbols.add(label, "route", true, lexed.lineAt(match.index));
  }

  return {
    symbols: symbols.list(),
    imports: imports.list(),
    identifiers: collectIdentifiers(masked),
  };
}

function isPublic(visibility: string | undefined): boolean {
  return visibility !== undefined && visibility.trim() === "pub";
}

function itemKind(keyword: string): RepoSymbolKind {
  if (keyword === "struct" || keyword === "enum" || keyword === "union") return "class";
  if (keyword === "trait" || keyword === "type") return "type";
  if (keyword === "mod") return "module";
  return "const";
}

function collectImpls(lexed: LexedSource): ImplScope[] {
  const scopes: ImplScope[] = [];
  for (const match of lexed.masked.matchAll(IMPL)) {
    const header = match[1];
    const forIndex = header.search(/\bfor\b/);
    const target = (forIndex >= 0 ? header.slice(forIndex + 3) : header).trim();
    const typeName = /([A-Za-z_]\w*)(?:\s*<.*)?$/.exec(target.replace(/^[&*\s]*(?:mut\s+|dyn\s+)?/, ""))?.[1];
    if (!typeName) continue;
    const open = match.index + match[0].length - 1;
    scopes.push({ typeName, start: open, end: lexed.matchingBrace(open), isTraitImpl: forIndex >= 0 });
  }
  return scopes;
}

/** Marks `as` aliases with a character no use path contains, then drops spaces. */
const USE_ALIAS = "|";

function normalizeUseTree(tree: string): string {
  return tree.replace(/\s+as\s+/g, USE_ALIAS).replace(/\s+/g, "");
}

interface UsePath {
  path: string;
  exportedName: string;
}

/**
 * Expands a normalized `crate::a::{b, c::d as e}` into `crate::a::b` and
 * `crate::a::c::d`.
 */
function flattenUseTree(tree: string, prefix = ""): UsePath[] {
  const braceStart = tree.indexOf("{");
  if (braceStart < 0) {
    const [path, alias] = tree.split(USE_ALIAS);
    const full = `${prefix}${path}`;
    if (!path) return [];
    const last = full.split("::").at(-1) ?? full;
    return [{ path: last === "self" ? full.slice(0, -"::self".length) : full, exportedName: alias || last }];
  }
  const head = `${prefix}${tree.slice(0, braceStart)}`;
  const body = tree.slice(braceStart + 1, tree.lastIndexOf("}"));
  return splitTopLevel(body).flatMap((part) => flattenUseTree(part, head));
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}
