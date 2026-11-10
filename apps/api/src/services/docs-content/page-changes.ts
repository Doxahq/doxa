import { sourcePathForHref } from "@doxahq/docs-engine";
import { cappedUnifiedDiff } from "../docs-branches/unified-diff";
import { hrefForSourcePath } from "../docs-branches/page-href";
import type { BranchChangeWrite } from "../../repositories/docs-branches";
import type { PageHrefMove } from "../../repositories/generation-review-records";

/** What one page edit changed. */
export interface DocsPageChange {
  readonly href: string;
  /** The href that the page had before this edit moved it. Null when it stayed. */
  readonly movedFrom: string | null;
  /** True when the page did not exist before this edit. */
  readonly isNew: boolean;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** Null when the text stayed the same, or when the page is over the line budget. */
  readonly diff: string | null;
}

const MAX_DIFF_LINES = 200;
/** A page can have very long lines, so the line limit alone does not bound the size. */
const MAX_DIFF_CHARACTERS = 16_000;
/**
 * The diff is quadratic on dissimilar text and runs on the Worker after the
 * edit is saved, so it must stay far below the CPU limit. This is for one
 * tool call. A page over the budget shows in the activity without a diff.
 */
const MAX_DIFF_SOURCE_LINES = 4_000;
const PAGE_SOURCE_PATH = /^source\/(?:.+\/)?index\.mdx$/;

interface SourceReader {
  read(path: string): Promise<string | null>;
}

/** Pure: the changed-line counts, from the full diff. Hunks start at the first `@@`. */
export function countDiffLines(diff: string): { linesAdded: number; linesRemoved: number } {
  const lines = diff.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  const body = firstHunk === -1 ? [] : lines.slice(firstHunk);
  return {
    linesAdded: body.filter((line) => line.startsWith("+")).length,
    linesRemoved: body.filter((line) => line.startsWith("-")).length,
  };
}

function limitDiff(diff: string): string {
  return diff.split("\n").slice(0, MAX_DIFF_LINES).join("\n").slice(0, MAX_DIFF_CHARACTERS);
}

function lineCount(text: string | null): number {
  return text === null ? 0 : text.split("\n").length
}

function describeWrite(
  write: BranchChangeWrite,
  before: string | null,
  movedFrom: string | null,
  lineBudget: { remaining: number },
): DocsPageChange | null {
  const after = write.kind === "upsert" ? write.content : null;
  const lines = lineCount(before) + lineCount(after);
  const canDiff = before !== after && lines <= lineBudget.remaining;
  // A moved page is always reported, because its event names its new href.
  if (!canDiff && movedFrom === null) return null;
  const location = { href: hrefForSourcePath(write.path), movedFrom, isNew: before === null };
  if (!canDiff) return { ...location, linesAdded: 0, linesRemoved: 0, diff: null };
  lineBudget.remaining -= lines;
  const { diff } = cappedUnifiedDiff({
    path: write.path,
    before,
    after,
    maxLines: Number.POSITIVE_INFINITY,
  });
  return { ...location, ...countDiffLines(diff), diff: limitDiff(diff) };
}

/** A reset page goes back to the published text, which `tree` does not hold here. */
function isDescribablePage(write: BranchChangeWrite): boolean {
  return write.kind !== "reset" && PAGE_SOURCE_PATH.test(write.path);
}

/**
 * The saved edit stands even if this read fails, so a failure gives an empty
 * list. The live activity then shows the edit without its diff. A move is one
 * change at the new href, compared with the text at the old href.
 */
export async function describePageChanges(
  tree: SourceReader,
  writes: readonly BranchChangeWrite[],
  moves: readonly PageHrefMove[] = [],
): Promise<DocsPageChange[]> {
  try {
    const movedFromByPath = new Map(moves.map(({ from, to }) => [sourcePathForHref(to), from]));
    const movedAwayPaths = new Set(moves.map(({ from }) => sourcePathForHref(from)));
    const pages = writes.filter(
      (write) => isDescribablePage(write) && !(write.kind === "delete" && movedAwayPaths.has(write.path)),
    );
    const before = await Promise.all(
      pages.map((write) => {
        const movedFrom = movedFromByPath.get(write.path);
        return tree.read(movedFrom === undefined ? write.path : sourcePathForHref(movedFrom));
      }),
    );
    const lineBudget = { remaining: MAX_DIFF_SOURCE_LINES };
    return pages.flatMap(
      (write, index) =>
        describeWrite(write, before[index] ?? null, movedFromByPath.get(write.path) ?? null, lineBudget) ?? [],
    );
  } catch (cause) {
    console.error("Could not describe the changed pages.", cause instanceof Error ? cause.message : "Unknown error.");
    return [];
  }
}
