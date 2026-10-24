import type {
  DocsContentEdit,
  DocsMdxIssue,
  DocsPageMdxIssues,
} from "@doxahq/contracts";
import { normalizeHref, sourcePathForHref } from "@doxahq/docs-engine";
import type { StoredBranchChange } from "../../repositories/docs-branches";
import { hrefForSourcePath } from "../docs-branches/page-href";
import { checkMdxSource } from "./mdx-check";

/** How many pages a blocked-publish message names before "and N more". */
const NAMED_PAGES_LIMIT = 5;

/**
 * The dashboard's view of `checkMdxSource`: the same check that agent writes
 * get, with the position split out so the editor can point at the line.
 */
export function pageMdxIssues(source: string): DocsMdxIssue[] {
  return checkMdxSource(source).map((issue) => ({
    line: positiveParam(issue.params?.line),
    column: positiveParam(issue.params?.column),
    message: reasonOf(issue.params?.reason, issue.message),
  }));
}

/** The pages that a dashboard save writes and that fail the MDX check. */
export function editMdxIssues(
  edits: readonly DocsContentEdit[],
): DocsPageMdxIssues[] {
  return edits.flatMap((edit) => {
    if (edit.type !== "set_page_content") return [];
    const href = normalizeHref(edit.href);
    return withIssues(href, sourcePathForHref(href), edit.content);
  });
}

/**
 * The changed pages of a branch that fail the MDX check. Only pages the
 * branch writes are checked: unchanged pages are already live.
 */
export function branchMdxIssues(
  changes: readonly StoredBranchChange[],
): DocsPageMdxIssues[] {
  return [...changes]
    .sort((left, right) => left.path.localeCompare(right.path))
    .flatMap((change) =>
      change.kind === "upsert" && isPageSourcePath(change.path)
        ? withIssues(hrefForSourcePath(change.path), change.path, change.content)
        : [],
    );
}

/** One sentence that names the blocked pages, for agents and the dashboard. */
export function describeBlockedPublish(
  pages: readonly DocsPageMdxIssues[],
): string {
  const named = pages.slice(0, NAMED_PAGES_LIMIT).map(describePage);
  const rest = pages.length - named.length;
  const list = rest > 0 ? `${named.join("; ")}; and ${rest} more` : named.join("; ");
  const subject = pages.length === 1 ? "1 page has" : `${pages.length} pages have`;
  return `Publish blocked: ${subject} MDX issues. ${list}. Fix them, then publish again.`;
}

function describePage(page: DocsPageMdxIssues): string {
  const [first] = page.issues;
  const line = first?.line ? ` line ${first.line}` : "";
  return `${page.href} (${page.sourcePath}${line}): ${first?.message ?? "invalid MDX"}`;
}

function withIssues(
  href: string,
  sourcePath: string,
  source: string,
): DocsPageMdxIssues[] {
  const issues = pageMdxIssues(source);
  return issues.length > 0 ? [{ href, sourcePath, issues }] : [];
}

function isPageSourcePath(path: string): boolean {
  return path.startsWith("source/") && path.endsWith(".mdx");
}

function positiveParam(value: string | number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function reasonOf(reason: string | number | undefined, fallback: string): string {
  return typeof reason === "string" && reason.length > 0 ? reason : fallback;
}
