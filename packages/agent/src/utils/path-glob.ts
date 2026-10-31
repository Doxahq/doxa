/** Nested brace lists multiply, so a short glob can name millions of patterns. */
const MAX_GLOB_ALTERNATIVES = 256;

/**
 * Repository path globs, relative to the repository root. `*` and `?` match
 * inside one path segment, `**` matches across segments, and `{a,b}` lists
 * alternatives.
 */
export function compilePathGlob(pattern: string): (path: string) => boolean {
  const alternatives = expandBracePattern(normalizePath(pattern));
  if (alternatives.length > MAX_GLOB_ALTERNATIVES) {
    throw new Error(`The path glob ${JSON.stringify(pattern)} has more than ${MAX_GLOB_ALTERNATIVES} alternatives.`);
  }
  const matchers = alternatives.map(globToRegExp);
  return (path) => matchers.some((matcher) => matcher.test(path));
}

/** Forward slashes and no leading slash, as the globs expect. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Stops one past the limit, so that the caller can reject the glob. */
function expandBracePattern(pattern: string): string[] {
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

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      const after = pattern[index + 2];
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
