/**
 * Agent Commentary Patterns
 *
 * Centralized list of regex patterns that match LLM meta-commentary
 * (preambles, closing remarks, narration about the writing process)
 * and the helper that strips them from the leading and trailing
 * paragraphs of generated content.
 */

/**
 * Patterns matched against the first/last paragraph of generated content.
 * Each pattern is anchored at the start (`^`) so we only catch lines that
 * literally open with meta-commentary; we don't strip mid-sentence matches.
 */
export const COMMENTARY_PATTERNS: readonly RegExp[] = [
  // Process narration — "now I will / let me ..."
  /^now i have\b/i,
  /^now i'?ll\b/i,
  /^now i'?m going to\b/i,
  /^now let me\b/i,
  /^now,?\s+let me\b/i,
  /^let me write\b/i,
  /^let me create\b/i,
  /^let me compose\b/i,
  /^let me put\b/i,
  /^i'?ll now\b/i,
  /^i will now\b/i,
  /^i'?ll create\b/i,

  // Self-report — "I've analyzed / explored / gathered ..."
  /^i'?ve analyzed\b/i,
  /^i have analyzed\b/i,
  /^i'?ve explored\b/i,
  /^i have explored\b/i,
  /^i'?ve gathered\b/i,
  /^i have all the\b/i,
  /^i have enough\b/i,
  /^i now have\b/i,

  // After-the-fact — "after reviewing / based on ..."
  /^after reviewing\b/i,
  /^after analyzing\b/i,
  /^after exploring\b/i,
  /^based on (?:the|my) (?:codebase|analysis|exploration|review|investigation)\b/i,

  // Output framing — "here's the ..."
  /^here'?s the documentation\b/i,
  /^here'?s the complete\b/i,
  /^here'?s the updated\b/i,
  /^here'?s the final\b/i,
  /^here is the\b/i,
  /^here'?s a (?:complete|comprehensive|detailed)\b/i,
  /^here'?s the (?:architecture|configuration|deployment|overview|getting.started|quickstart)\b/i,
  /^the following (?:is|documentation|page|section)\b/i,

  // Closing remarks
  /^this documentation\b/i,
  /^the above documentation\b/i,
  /^this completes\b/i,
  /^that covers\b/i,
  /^this page covers\b/i,
  /^i hope this\b/i,

  // Filler acknowledgements
  /^perfect[,.]?\s/i,
  /^great[,.]?\s/i,
  /^alright[,.]?\s/i,
  /^excellent[,.]?\s/i,
];

/**
 * Strip leading and trailing meta-commentary lines from generated content.
 *
 * Walks from each end inward, dropping blank lines and lines that match a
 * commentary pattern. Stops as soon as we hit a heading, frontmatter delimiter,
 * or any line that doesn't match a pattern — we never reach into the middle of
 * the document.
 */
export function stripAgentCommentary(content: string): string {
  const lines = content.split("\n");

  // Leading
  while (lines.length > 0) {
    const line = lines[0].trim();
    if (line === "") {
      lines.shift();
      continue;
    }
    if (line.startsWith("#") || line.startsWith("---")) break;
    if (COMMENTARY_PATTERNS.some((pattern) => pattern.test(line))) {
      lines.shift();
      continue;
    }
    break;
  }

  // Trailing
  while (lines.length > 0) {
    const line = lines[lines.length - 1].trim();
    if (line === "") {
      lines.pop();
      continue;
    }
    if (COMMENTARY_PATTERNS.some((pattern) => pattern.test(line))) {
      lines.pop();
      continue;
    }
    break;
  }

  return lines.join("\n");
}
