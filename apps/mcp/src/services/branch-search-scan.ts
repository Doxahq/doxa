import { classifyBranchPath } from "@doxahq/contracts/docs-branches";
import type { StoredBranchChange } from "@doxahq/api/repositories/docs-branches";
import { hrefForSourcePath } from "@doxahq/api/services/docs-branches/page-href";

/** Spec 6.3: a branch search scans at most this much page source. */
export const BRANCH_SCAN_LIMITS = {
  maxPages: 500,
  maxBytes: 2 * 1024 * 1024,
} as const;

export type BranchScanStop = "page_limit" | "size_limit";

export interface ScannedPage {
  href: string;
  content: string;
}

export interface BranchScan {
  /** Pages of the branch to index, in path order. */
  pages: ScannedPage[];
  /**
   * Hrefs the live index must not answer for: pages the branch deleted, and
   * changed pages the scan left out at a limit, whose live text is stale.
   */
  hiddenHrefs: Set<string>;
  /** Null when the scan read every changed page. */
  stop: BranchScanStop | null;
}

/**
 * Picks the changed pages of a branch to search. Pages count in path order
 * until the page or the byte limit; a deleted page costs nothing.
 */
export function scanBranchPages(
  changes: readonly StoredBranchChange[],
  limits: { maxPages: number; maxBytes: number } = BRANCH_SCAN_LIMITS,
): BranchScan {
  const pages: ScannedPage[] = [];
  const hiddenHrefs = new Set<string>();
  let bytes = 0;
  let stop: BranchScanStop | null = null;
  const pageChanges = changes
    .filter((change) => classifyBranchPath(change.path) === "page")
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const change of pageChanges) {
    const href = hrefForSourcePath(change.path);
    if (change.kind === "delete") {
      hiddenHrefs.add(href);
      continue;
    }
    stop ??= limitReached(pages.length, bytes + change.byteSize, limits);
    if (stop) {
      hiddenHrefs.add(href);
      continue;
    }
    pages.push({ href, content: change.content });
    bytes += change.byteSize;
  }

  return { pages, hiddenHrefs, stop };
}

function limitReached(
  pageCount: number,
  bytesAfter: number,
  limits: { maxPages: number; maxBytes: number },
): BranchScanStop | null {
  if (pageCount >= limits.maxPages) return "page_limit";
  if (bytesAfter > limits.maxBytes) return "size_limit";
  return null;
}
