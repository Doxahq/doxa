import { compareStrings } from "../collections";
import { stringLiteralAt } from "../mask";
import type { RepoImport, RepoSymbol, RepoSymbolKind } from "../types";

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
/** Shorter names match too many unrelated files to count as references. */
const MIN_REFERENCE_IDENTIFIER_LENGTH = 3;

/** Masked and original text of one file, with offset helpers. */
export class LexedSource {
  private readonly lineStarts: number[];
  private depths: Int32Array | null = null;

  constructor(
    readonly original: string,
    readonly masked: string,
  ) {
    this.lineStarts = [0];
    for (let index = 0; index < masked.length; index++) {
      if (masked[index] === "\n") this.lineStarts.push(index + 1);
    }
  }

  /** 1-based line number of an offset. */
  lineAt(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  /** `{}` nesting depth at an offset; comments and strings never count. */
  braceDepthAt(offset: number): number {
    if (!this.depths) this.depths = computeBraceDepths(this.masked);
    return this.depths[Math.min(offset, this.depths.length - 1)] ?? 0;
  }

  /** The offset of the `}` matching the `{` at `openIndex`, or the end. */
  matchingBrace(openIndex: number): number {
    let depth = 0;
    for (let index = openIndex; index < this.masked.length; index++) {
      const char = this.masked[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return this.masked.length;
  }

  /** The original string literal opened by the quote at `quoteIndex`. */
  stringAt(quoteIndex: number): string | null {
    return stringLiteralAt(this.original, this.masked, quoteIndex);
  }

  /** Offset of the first quote character at or after `from`, within `limit`. */
  quoteAfter(from: number, limit = 400): number {
    const end = Math.min(this.masked.length, from + limit);
    for (let index = from; index < end; index++) {
      const char = this.masked[index];
      if (char === '"' || char === "'" || char === "`") return index;
    }
    return -1;
  }
}

function computeBraceDepths(masked: string): Int32Array {
  const depths = new Int32Array(masked.length + 1);
  let depth = 0;
  for (let index = 0; index < masked.length; index++) {
    depths[index] = depth;
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") depth = Math.max(0, depth - 1);
  }
  depths[masked.length] = depth;
  return depths;
}

export function collectIdentifiers(masked: string): Set<string> {
  const identifiers = new Set<string>();
  for (const match of masked.matchAll(IDENTIFIER)) {
    if (match[0].length >= MIN_REFERENCE_IDENTIFIER_LENGTH) identifiers.add(match[0]);
  }
  return identifiers;
}

/** Collects symbols and keeps the first declaration of each name and kind. */
export class SymbolCollector {
  private readonly byKey = new Map<string, RepoSymbol>();

  add(name: string, kind: RepoSymbolKind, exported: boolean, line: number): void {
    const key = `${kind}:${name}`;
    const existing = this.byKey.get(key);
    if (existing) {
      existing.exported = existing.exported || exported;
      return;
    }
    this.byKey.set(key, { name, kind, exported, line });
  }

  /** Marks a declared symbol as exported. Returns false when none exists. */
  markExported(name: string): boolean {
    let found = false;
    for (const symbol of this.byKey.values()) {
      if (symbol.name === name && symbol.kind !== "reexport" && symbol.kind !== "route") {
        symbol.exported = true;
        found = true;
      }
    }
    return found;
  }

  list(): RepoSymbol[] {
    return [...this.byKey.values()].sort(
      (a, b) => a.line - b.line || compareStrings(a.name, b.name) || compareStrings(a.kind, b.kind),
    );
  }
}

export class ImportCollector {
  private readonly byKey = new Map<string, RepoImport>();

  add(entry: RepoImport): void {
    const specifier = entry.specifier.trim();
    if (!specifier) return;
    const key = `${entry.kind ?? ""}:${specifier}`;
    const existing = this.byKey.get(key);
    if (!existing) {
      this.byKey.set(key, { ...entry, specifier });
      return;
    }
    if (entry.names?.length) {
      existing.names = [...new Set([...(existing.names ?? []), ...entry.names])].sort(compareStrings);
    }
  }

  list(): RepoImport[] {
    return [...this.byKey.values()].sort((a, b) =>
      compareStrings(a.specifier, b.specifier) || compareStrings(a.kind ?? "", b.kind ?? ""),
    );
  }
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

/** A route label like `GET /users`, or null when the path is not a URL path. */
export function routeLabel(method: string | null, path: string | null): string | null {
  if (!path || !path.startsWith("/")) return null;
  const normalized = method?.toLowerCase();
  const verb = normalized && HTTP_METHODS.has(normalized) ? normalized.toUpperCase() : null;
  return verb ? `${verb} ${path}` : path;
}
