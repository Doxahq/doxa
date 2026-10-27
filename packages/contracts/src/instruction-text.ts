/**
 * Cleans free text that people write for Doxabot (project instructions, the
 * repository instructions file, agent notes) before it reaches a prompt.
 *
 * It removes what a reader cannot see but a model still reads: HTML comments,
 * zero-width and direction marks, Unicode tag characters and other control
 * characters. Visible text stays as it is.
 */

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Invisible characters that can carry hidden text:
 * - C0/C1 controls except tab and line feed
 * - zero-width and joiner marks (U+200B–U+200F, U+2060–U+2064, U+FEFF)
 * - direction overrides and isolates (U+202A–U+202E, U+2066–U+2069)
 * - variation selectors (U+FE00–U+FE0F, U+E0100–U+E01EF)
 * - Unicode tag characters (U+E0000–U+E007F)
 */
const INVISIBLE_CHARACTERS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩︀-️﻿]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

export function cleanInstructionText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(HTML_COMMENT, "")
    .replace(INVISIBLE_CHARACTERS, "")
    .trim();
}

/**
 * Cyrillic and Greek letters that look like Latin letters, such as the
 * Cyrillic "і" in "іgnore". Only screening uses this map. The saved text
 * keeps its letters, so instructions in Russian or Greek stay correct.
 */
const LATIN_LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  "а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j",
  "к": "k", "ӏ": "l", "м": "m", "н": "h", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s",
  "т": "t", "ս": "u", "ԝ": "w", "х": "x", "у": "y",
  "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I", "Ј": "J", "К": "K",
  "М": "M", "О": "O", "Р": "P", "Ѕ": "S", "Т": "T", "Х": "X", "Ү": "Y",
  // Greek
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t",
  "υ": "u", "χ": "x", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I",
  "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
const LATIN_LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LATIN_LOOKALIKES).join("")}]`, "gu");
const COMBINING_MARKS = /\p{M}/gu;

/**
 * The text as a screening rule must read it: cleaned, accents removed and
 * look-alike letters replaced by their Latin letters. Never store or show it.
 */
export function screeningSkeleton(value: string): string {
  return cleanInstructionText(value)
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(LATIN_LOOKALIKE_PATTERN, (letter) => LATIN_LOOKALIKES[letter] ?? letter);
}
