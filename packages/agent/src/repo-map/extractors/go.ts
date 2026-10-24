/**
 * Go declarations: functions, methods (as `Type.Method`), types in single
 * and grouped `type (...)` declarations, exported constants and variables,
 * imports, and `net/http`, chi, gin, and echo route registrations.
 * A name is exported when it starts with an uppercase letter.
 */

import type { FileExtraction, RepoSymbolKind } from "../types";
import {
  collectIdentifiers,
  ImportCollector,
  LexedSource,
  routeLabel,
  SymbolCollector,
} from "./shared";

const FUNCTION =
  /^func[ \t]*(?:\([ \t]*\w*[ \t]*\*?[ \t]*(\w+)(?:\[[^\]]*\])?[ \t]*\)[ \t]*)?([A-Za-z_]\w*)[ \t]*[[(]/gm;
const SINGLE_TYPE = /^type[ \t]+([A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]+(=[ \t]*)?(\w+)?/gm;
const TYPE_GROUP = /^type[ \t]*\(/gm;
const GROUP_MEMBER = /^[ \t]+([A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]+(=[ \t]*)?(\w+)?/gm;
const VALUE = /^(?:const|var)[ \t]+([A-Z]\w*)/gm;
const VALUE_GROUP = /^(const|var)[ \t]*\(/gm;
const VALUE_GROUP_MEMBER = /^[ \t]+([A-Z]\w*)\b/gm;
const SINGLE_IMPORT = /^import[ \t]+(?:[\w.]+[ \t]+)?(["`])/gm;
const IMPORT_GROUP = /^import[ \t]*\(/gm;
const ROUTE_CALL =
  /\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any)[ \t]*\(\s*(["`])/g;

export function extractGo(lexed: LexedSource): FileExtraction {
  const symbols = new SymbolCollector();
  const imports = new ImportCollector();
  const { masked } = lexed;

  for (const match of masked.matchAll(FUNCTION)) {
    const [, receiver, name] = match;
    const line = lexed.lineAt(match.index);
    if (receiver) {
      symbols.add(`${receiver}.${name}`, "method", isExported(receiver) && isExported(name), line);
    } else if (name !== "init" && name !== "main") {
      symbols.add(name, "function", isExported(name), line);
    }
  }

  for (const match of masked.matchAll(SINGLE_TYPE)) {
    symbols.add(match[1], typeKind(match[3]), isExported(match[1]), lexed.lineAt(match.index));
  }
  forEachGroup(lexed, TYPE_GROUP, (body, offset) => {
    for (const member of body.matchAll(GROUP_MEMBER)) {
      if (lexed.braceDepthAt(offset + member.index) > 0) continue;
      symbols.add(member[1], typeKind(member[3]), isExported(member[1]), lexed.lineAt(offset + member.index));
    }
  });

  for (const match of masked.matchAll(VALUE)) {
    symbols.add(match[1], "const", true, lexed.lineAt(match.index));
  }
  forEachGroup(lexed, VALUE_GROUP, (body, offset) => {
    for (const member of body.matchAll(VALUE_GROUP_MEMBER)) {
      if (lexed.braceDepthAt(offset + member.index) > 0) continue;
      symbols.add(member[1], "const", true, lexed.lineAt(offset + member.index));
    }
  });

  for (const match of masked.matchAll(SINGLE_IMPORT)) {
    const specifier = lexed.stringAt(match.index + match[0].length - 1);
    if (specifier) imports.add({ specifier });
  }
  forEachGroup(lexed, IMPORT_GROUP, (body, offset) => {
    for (let index = 0; index < body.length; index++) {
      const char = body[index];
      if (char !== '"' && char !== "`") continue;
      const specifier = lexed.stringAt(offset + index);
      if (specifier) imports.add({ specifier });
      const close = body.indexOf(char, index + 1);
      if (close < 0) break;
      index = close;
    }
  });

  for (const match of masked.matchAll(ROUTE_CALL)) {
    const method = match[1].startsWith("Handle") || match[1] === "Any" ? null : match[1];
    const label = routeLabel(method, lexed.stringAt(match.index + match[0].length - 1));
    if (label) symbols.add(label, "route", true, lexed.lineAt(match.index));
  }

  return {
    symbols: symbols.list(),
    imports: imports.list(),
    identifiers: collectIdentifiers(masked),
  };
}

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function typeKind(underlying: string | undefined): RepoSymbolKind {
  return underlying === "struct" ? "class" : "type";
}

/** Calls `visit` with the body of each `keyword (` ... `)` group. */
function forEachGroup(
  lexed: LexedSource,
  pattern: RegExp,
  visit: (body: string, offset: number) => void,
): void {
  for (const match of lexed.masked.matchAll(pattern)) {
    const start = match.index + match[0].length;
    const close = lexed.masked.indexOf("\n)", start);
    const end = close < 0 ? lexed.masked.length : close + 1;
    visit(lexed.masked.slice(start, end), start);
  }
}
