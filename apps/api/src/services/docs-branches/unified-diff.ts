import { DOCS_BRANCH_DIFF_MAX_LINES } from "@doxahq/contracts/docs-branches";
import { createTwoFilesPatch } from "diff";

export interface CappedUnifiedDiff {
  diff: string;
  /** Lines of the full diff, headers included. */
  lineCount: number;
  truncated: boolean;
}

const HEADER_OPTIONS = {
  includeIndex: false,
  includeUnderline: false,
  includeFileHeaders: true,
};

/**
 * A unified diff with 3 lines of context, cut after `maxLines` lines. A null
 * side is a missing file: the diff of an added file has only `+` lines.
 */
export function cappedUnifiedDiff(input: {
  path: string;
  before: string | null;
  after: string | null;
  maxLines?: number;
}): CappedUnifiedDiff {
  const maxLines = input.maxLines ?? DOCS_BRANCH_DIFF_MAX_LINES;
  const patch = createTwoFilesPatch(
    input.before === null ? "/dev/null" : `a/${input.path}`,
    input.after === null ? "/dev/null" : `b/${input.path}`,
    input.before ?? "",
    input.after ?? "",
    undefined,
    undefined,
    { context: 3, headerOptions: HEADER_OPTIONS },
  );
  const lines = patch.endsWith("\n")
    ? patch.slice(0, -1).split("\n")
    : patch.split("\n");
  const truncated = lines.length > maxLines;

  return {
    diff: `${(truncated ? lines.slice(0, maxLines) : lines).join("\n")}\n`,
    lineCount: lines.length,
    truncated,
  };
}

/**
 * Pretty-prints JSON with 2 spaces, so a minified and a formatted file diff
 * by value, line by line. Text that is not JSON stays as it is.
 */
export function formatJsonForDiff(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  } catch {
    return raw;
  }
}
