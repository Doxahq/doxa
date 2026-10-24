import type {
  DocsContentMdxReport,
  DocsMdxIssue,
  DocsPageMdxIssues,
} from "@doxahq/contracts"

/**
 * Helpers for the MDX check (v2 spec 8.1). A dashboard save always stands;
 * the save result and the branch report say which pages fail the check, and
 * a publish waits until none does.
 */

const NO_ISSUES: readonly DocsMdxIssue[] = []

/** The issues of one page, or none. */
export function issuesForPage(
  report: DocsContentMdxReport | undefined,
  href: string | null,
): readonly DocsMdxIssue[] {
  if (!report || href === null) return NO_ISSUES
  return report.pages.find((page) => page.href === href)?.issues ?? NO_ISSUES
}

/**
 * The report after a save: the saved pages take the issues from the save
 * result, and the other pages keep theirs. Pages stay in source path order.
 */
export function withSavedPageIssues(
  report: DocsContentMdxReport,
  savedHrefs: readonly string[],
  saved: readonly DocsPageMdxIssues[],
): DocsContentMdxReport {
  const replaced = new Set([...savedHrefs, ...saved.map((page) => page.href)])
  const pages = [...report.pages.filter((page) => !replaced.has(page.href)), ...saved]
  pages.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
  return { pages }
}

/**
 * The offset of a 1-based line and column in a source, for the code editor.
 * A position past the end clamps to the end of the source.
 */
export function sourceOffset(source: string, line: number, column = 1): number {
  let offset = 0
  for (let current = 1; current < line; current++) {
    const next = source.indexOf("\n", offset)
    if (next === -1) return source.length
    offset = next + 1
  }
  const lineEnd = source.indexOf("\n", offset)
  const end = lineEnd === -1 ? source.length : lineEnd
  return Math.min(offset + Math.max(0, column - 1), end)
}

/** "Line 7", or "Unknown line" when the parser gave no position. */
export function formatIssueLine(issue: DocsMdxIssue): string {
  return issue.line === null ? "Unknown line" : `Line ${issue.line}`
}
