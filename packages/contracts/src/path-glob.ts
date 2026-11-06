/**
 * Brace lists in repository path globs. Shared by the instructions schema,
 * which rejects a glob that names too many patterns, and by the agent, which
 * matches paths with the same expansion. No imports: the agent bundles this
 * file into its Worker-safe entry.
 */

/** Nested brace lists multiply, so a short glob can name millions of patterns. */
export const MAX_GLOB_ALTERNATIVES = 256;

/**
 * The patterns that a glob's brace lists name, `{a,b}/x` giving `a/x` and
 * `b/x`. Stops one past {@link MAX_GLOB_ALTERNATIVES}, so a caller can reject
 * the glob without expanding all of it.
 */
export function expandBracePattern(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];

  const [token, body] = match;
  const expanded: string[] = [];
  for (const value of body.split(",")) {
    expanded.push(...expandBracePattern(pattern.replace(token, value)));
    if (expanded.length > MAX_GLOB_ALTERNATIVES) break;
  }
  return expanded;
}

export function hasTooManyGlobAlternatives(pattern: string): boolean {
  return expandBracePattern(pattern).length > MAX_GLOB_ALTERNATIVES;
}
