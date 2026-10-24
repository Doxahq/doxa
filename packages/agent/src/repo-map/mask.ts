/**
 * Length-preserving source masker.
 * Replaces comment text and string contents with spaces and keeps newlines,
 * quote characters, and every offset. Extractors match declarations on the
 * masked text, so a keyword inside a comment or string never counts, and read
 * string values (import specifiers, route paths) from the original text at the
 * same offsets.
 */

import type { LexicalSyntax } from "./languages";

/** Keywords after which `/` starts a regular expression, not a division. */
const REGEX_PREFIX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "case", "do", "else", "in", "of",
  "void", "yield", "await", "delete", "throw", "new",
]);
const REGEX_PREFIX_CHARS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));

export function maskSource(source: string, syntax: LexicalSyntax): string {
  return new Masker(source, syntax).run();
}

/**
 * Reads the original body of the string literal whose opening quote sits at
 * `quoteIndex` in the masked text.
 */
export function stringLiteralAt(
  source: string,
  masked: string,
  quoteIndex: number,
): string | null {
  const quote = masked[quoteIndex];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const end = masked.indexOf(quote, quoteIndex + 1);
  if (end < 0) return null;
  return source.slice(quoteIndex + 1, end);
}

class Masker {
  private readonly out: string[];
  private index = 0;
  /** Brace depth of each open `${` in a template literal, innermost last. */
  private readonly templateDepths: number[] = [];

  constructor(
    private readonly source: string,
    private readonly syntax: LexicalSyntax,
  ) {
    this.out = source.split("");
  }

  run(): string {
    while (this.index < this.source.length) {
      this.step();
    }
    return this.out.join("");
  }

  private step(): void {
    const { source, syntax } = this;
    const char = source[this.index];

    if (this.templateDepths.length > 0 && (char === "{" || char === "}")) {
      this.trackTemplateBrace(char);
      return;
    }
    if (syntax.lineComments.some((marker) => source.startsWith(marker, this.index))) {
      this.blankUntil(this.lineEnd(this.index));
      return;
    }
    if (syntax.blockComment && source.startsWith(syntax.blockComment.open, this.index)) {
      this.blankUntil(this.blockCommentEnd());
      return;
    }
    if (syntax.tripleQuotes && (source.startsWith('"""', this.index) || source.startsWith("'''", this.index))) {
      this.maskDelimited(source.slice(this.index, this.index + 3), true);
      return;
    }
    if (syntax.rustLiterals && this.maskRustLiteral()) return;
    if (syntax.templateLiterals && char === "`") {
      this.maskTemplate();
      return;
    }
    if (syntax.rawQuotes.includes(char)) {
      this.maskDelimited(char, false);
      return;
    }
    if (syntax.quotes.includes(char)) {
      this.maskDelimited(char, true);
      return;
    }
    if (syntax.regexLiterals && char === "/" && this.regexAllowed()) {
      const end = this.regexEnd();
      if (end > 0) {
        this.blankRange(this.index + 1, end - 1);
        this.index = end;
        return;
      }
    }
    this.index += 1;
  }

  private trackTemplateBrace(char: string): void {
    const top = this.templateDepths.length - 1;
    if (char === "{") {
      this.templateDepths[top] += 1;
      this.index += 1;
      return;
    }
    if (this.templateDepths[top] > 0) {
      this.templateDepths[top] -= 1;
      this.index += 1;
      return;
    }
    // The `}` that closes `${`: resume the template text.
    this.templateDepths.pop();
    this.index += 1;
    this.maskTemplateText();
  }

  private maskTemplate(): void {
    this.index += 1;
    this.maskTemplateText();
  }

  /** Masks template text up to the closing backtick or the next `${`. */
  private maskTemplateText(): void {
    const { source } = this;
    while (this.index < source.length) {
      const char = source[this.index];
      if (char === "\\") {
        this.blankRange(this.index, this.index + 2);
        this.index += 2;
        continue;
      }
      if (char === "`") {
        this.index += 1;
        return;
      }
      if (char === "$" && source[this.index + 1] === "{") {
        this.templateDepths.push(0);
        this.index += 2;
        return;
      }
      this.blankRange(this.index, this.index + 1);
      this.index += 1;
    }
  }

  private maskDelimited(delimiter: string, escapes: boolean): void {
    const { source } = this;
    const singleLine = delimiter.length === 1 && delimiter !== "`";
    let cursor = this.index + delimiter.length;
    while (cursor < source.length) {
      if (escapes && source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source.startsWith(delimiter, cursor)) break;
      // An unterminated quote ends at the line end, like most lexers recover.
      if (singleLine && source[cursor] === "\n") break;
      cursor += 1;
    }
    const contentEnd = Math.min(cursor, source.length);
    this.blankRange(this.index + delimiter.length, contentEnd);
    this.index = source.startsWith(delimiter, contentEnd)
      ? contentEnd + delimiter.length
      : contentEnd;
  }

  /** Rust raw strings, byte strings, and char literals. Lifetimes stay code. */
  private maskRustLiteral(): boolean {
    const { source } = this;
    const raw = /^b?r(#*)"/.exec(source.slice(this.index, this.index + 260));
    if (raw && !this.isIdentifierChar(source[this.index - 1])) {
      const closing = `"${raw[1]}`;
      const contentStart = this.index + raw[0].length;
      const close = source.indexOf(closing, contentStart);
      const contentEnd = close < 0 ? source.length : close;
      this.blankRange(contentStart, contentEnd);
      this.index = close < 0 ? source.length : close + closing.length;
      return true;
    }
    if (source[this.index] === "'") {
      const char = /^'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/u.exec(
        source.slice(this.index, this.index + 12),
      );
      if (char) {
        this.blankRange(this.index + 1, this.index + char[0].length - 1);
        this.index += char[0].length;
        return true;
      }
      this.index += 1;
      return true;
    }
    return false;
  }

  private regexAllowed(): boolean {
    const { source } = this;
    if (source[this.index + 1] === "/" || source[this.index + 1] === "*") return false;
    let cursor = this.index - 1;
    while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
    if (cursor < 0) return true;
    const previous = source[cursor];
    if (REGEX_PREFIX_CHARS.has(previous)) return true;
    if (!this.isIdentifierChar(previous)) return false;
    let start = cursor;
    while (start > 0 && this.isIdentifierChar(source[start - 1])) start -= 1;
    return REGEX_PREFIX_KEYWORDS.has(source.slice(start, cursor + 1));
  }

  /** The offset after the closing `/`, or -1 when this is not a regex literal. */
  private regexEnd(): number {
    const { source } = this;
    let inClass = false;
    for (let cursor = this.index + 1; cursor < source.length; cursor++) {
      const char = source[cursor];
      if (char === "\n") return -1;
      if (char === "\\") {
        cursor += 1;
        continue;
      }
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) return cursor + 1;
    }
    return -1;
  }

  private blockCommentEnd(): number {
    const { source } = this;
    const comment = this.syntax.blockComment;
    if (!comment) return this.index;
    let depth = 0;
    let cursor = this.index;
    while (cursor < source.length) {
      if (source.startsWith(comment.open, cursor) && (depth === 0 || comment.nested)) {
        depth += 1;
        cursor += comment.open.length;
        continue;
      }
      if (source.startsWith(comment.close, cursor)) {
        depth -= 1;
        cursor += comment.close.length;
        if (depth === 0) return cursor;
        continue;
      }
      cursor += 1;
    }
    return source.length;
  }

  private lineEnd(from: number): number {
    const end = this.source.indexOf("\n", from);
    return end < 0 ? this.source.length : end;
  }

  private blankUntil(end: number): void {
    this.blankRange(this.index, end);
    this.index = end;
  }

  private blankRange(start: number, end: number): void {
    const stop = Math.min(end, this.source.length);
    for (let cursor = start; cursor < stop; cursor++) {
      if (this.out[cursor] !== "\n") this.out[cursor] = " ";
    }
  }

  private isIdentifierChar(char: string | undefined): boolean {
    return char !== undefined && /[\w$]/.test(char);
  }
}
