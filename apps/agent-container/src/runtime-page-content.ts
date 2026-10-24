/** A fence opener or closer: three or more backticks or tildes. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * MDX ESM at the top level: up to three leading spaces, then `import` or
 * `export`. Four or more spaces is an indented code block, not ESM.
 */
const MDX_ESM_RE = /^ {0,3}(import|export)\s/;

/**
 * Removes top-level MDX `import` and `export` statements from a generated page.
 *
 * The runtime parser rejects `mdxjsEsm` nodes. The renderer injects every
 * supported component automatically, so a generated page never needs these
 * statements.
 *
 * This function deliberately preserves fenced and indented code samples and
 * all component tags. Component security remains enforced by the canonical
 * runtime allowlist during page validation and runtime parsing.
 */
export function stripUnsupportedMdxEsm(
  content: string,
  onDropped?: (line: string) => void,
): string {
  const kept: string[] = [];
  let openFence: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    const fence = FENCE_RE.exec(line)?.[1];
    if (fence) {
      if (openFence === null) {
        openFence = fence;
      } else if (
        fence[0] === openFence[0] &&
        fence.length >= openFence.length
      ) {
        openFence = null;
      }
      kept.push(line);
      continue;
    }

    if (openFence === null && MDX_ESM_RE.test(line)) {
      onDropped?.(line);
      continue;
    }

    kept.push(line);
  }

  return `${kept.join("\n").trimEnd()}\n`;
}
