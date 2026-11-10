import type { DocsPageChange } from "@doxahq/api/services/docs-content/page-changes";
import { normalizeHref } from "@doxahq/docs-engine";
import type { ToolActivity } from "../../tool-definition";

/** One `edit_docs` call can touch 50 pages. The feed stays readable. */
export const MAX_EDIT_ACTIVITIES = 10;

const STRUCTURE_DETAIL = "Site structure";

interface DescribedEdit {
  readonly type: string;
  readonly href?: string;
}

/** What every line of one `edit_docs` call shares. */
type SharedActivity = Required<Pick<ToolActivity, "branchId" | "note" | "branchRevision">>;

/**
 * One activity per page, and one for changes to sections and groups. The saved
 * page changes give the real addresses: the edit of a new page has no href,
 * and a renamed or moved page ends at another href.
 */
export function describeDocsEdits(
  edits: readonly DescribedEdit[],
  shared: SharedActivity,
  pageChanges: readonly DocsPageChange[],
): ToolActivity[] {
  const movedTo = new Map(
    pageChanges.flatMap(({ href, movedFrom }) => (movedFrom === null ? [] : [[movedFrom, href] as const])),
  );
  const pageHrefs = new Set(pageChanges.filter(({ isNew }) => isNew).map(({ href }) => href));
  const savedNewPage = pageHrefs.size > 0;
  let changedStructure = false;
  for (const edit of edits) {
    if (edit.href !== undefined) {
      const href = normalizeHref(edit.href);
      pageHrefs.add(movedTo.get(href) ?? href);
    } else if (edit.type !== "create_page" || !savedNewPage) {
      changedStructure = true;
    }
  }
  const activities = [...pageHrefs].map((pageHref): ToolActivity => ({ kind: "edit", ...shared, pageHref }));
  if (changedStructure) activities.push({ kind: "edit", ...shared, detail: STRUCTURE_DETAIL });
  if (activities.length <= MAX_EDIT_ACTIVITIES) return activities;
  const others = activities.length - MAX_EDIT_ACTIVITIES;
  return [
    ...activities.slice(0, MAX_EDIT_ACTIVITIES),
    { kind: "edit", ...shared, detail: `${others} more ${others === 1 ? "page" : "pages"}` },
  ];
}
