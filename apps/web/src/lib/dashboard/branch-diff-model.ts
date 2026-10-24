import type { DocsBranchDiff, DocsBranchFileChange } from "@doxahq/contracts/docs-branches"

/** A Badge variant name. */
type ChangeBadgeVariant = "success" | "muted" | "danger"

/** The badge of a changed page: added and deleted pages stand out. */
export const FILE_CHANGE_BADGE: Record<
  DocsBranchFileChange,
  { label: string; variant: ChangeBadgeVariant }
> = {
  added: { label: "Added", variant: "success" },
  edited: { label: "Edited", variant: "muted" },
  deleted: { label: "Deleted", variant: "danger" },
}

/** Structure files and site settings changed by the branch. */
export function otherChangeCount(diff: DocsBranchDiff): number {
  return diff.structure.length + (diff.siteSettings ? 1 : 0)
}
