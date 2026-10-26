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
