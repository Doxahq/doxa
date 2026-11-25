import type { ProductAnalytics, ProductEventProperties } from "@doxahq/analytics";
import type { DocsContentEdit } from "@doxahq/contracts";
import type { StoredDocsBranch } from "../../repositories/docs-branch-records";
import type { ResolvedBranchContext } from "../docs-branches/branch-resolver";
import type { DocsContentActor } from "./service";

type BranchKind = ProductEventProperties<"docs_page_saved">["branch_kind"];

/** Edits that write a page. Site settings and navigation edits are not page saves. */
const PAGE_EDITS: ReadonlySet<DocsContentEdit["type"]> = new Set([
  "set_home_page",
  "set_page_content",
  "reset_page",
  "create_page",
  "rename_page",
  "set_page_icon",
  "move_page",
  "delete_page",
]);

/** Main (its hidden draft branch), a generation review, or any other branch. */
export function branchKindOf(context: {
  readonly branchRef: ResolvedBranchContext["branchRef"];
  readonly branch: Pick<StoredDocsBranch, "purpose"> | null;
}): BranchKind {
  if (context.branchRef === "main") return "main";
  return context.branch?.purpose === "generation_review" ? "review" : "feature";
}

/** `docs_page_saved`, once for each save that wrote at least one page. */
export function capturePageSaved(
  analytics: ProductAnalytics,
  input: { actor: DocsContentActor; projectId: string; context: ResolvedBranchContext; edits: readonly DocsContentEdit[] },
): void {
  if (!input.edits.some((edit) => PAGE_EDITS.has(edit.type))) return;
  analytics.capture({
    name: "docs_page_saved",
    distinctId: input.actor.userId,
    properties: { via: input.actor.origin, branch_kind: branchKindOf(input.context) },
    groups: { project: input.projectId },
  });
}
