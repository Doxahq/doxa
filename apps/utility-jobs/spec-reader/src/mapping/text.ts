import { SPEC_READER_LIMITS } from "@doxahq/contracts/spec-reader";
import type { SpecValue } from "../document/tree";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Prose from a spec: Unicode NFC, `\n` line endings, trimmed and cut to
 * `maxChars` with an ellipsis. Empty text is undefined. Markdown stays as it
 * is; the agent container sanitizes it.
 */
export function specText(value: SpecValue | undefined, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  return text ? cutText(text, maxChars) : undefined;
}

/**
 * A name from a spec: a parameter, field, tag or scheme name. It is NFC and
 * trimmed, and undefined when it is empty, longer than the name limit or
 * holds a control character.
 */
export function specName(value: SpecValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.normalize("NFC").trim();
  if (!name || name.length > SPEC_READER_LIMITS.maxNameChars || CONTROL_CHARACTERS.test(name)) {
    return undefined;
  }
  return name;
}

export function hasControlCharacter(text: string): boolean {
  return CONTROL_CHARACTERS.test(text);
}

/** Cuts text to `maxChars` code points, the last one an ellipsis, never inside a surrogate pair. */
export function cutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = "";
  let count = 0;
  for (const codePoint of text) {
    if (count === maxChars - 1) return `${cut.trimEnd()}…`;
    cut += codePoint;
    count += 1;
  }
  return cut;
}
