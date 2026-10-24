/**
 * Token budget for the rendered repo map.
 * Counting uses a chars/4 estimate: close enough for English and code with
 * Claude and GPT tokenizers, and free to compute. Keep the ratio here only.
 */

export const REPO_MAP_CHARS_PER_TOKEN = 4;

/**
 * About 1.5k tokens: the range other repo-map planners use (1–2k). Large
 * enough to name every area and the top files, small enough to sit in the
 * cached system prefix of every exploration step.
 */
export const DEFAULT_REPO_MAP_TOKEN_BUDGET = 1_500;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / REPO_MAP_CHARS_PER_TOKEN);
}

export function charsForTokens(tokens: number): number {
  return tokens * REPO_MAP_CHARS_PER_TOKEN;
}
