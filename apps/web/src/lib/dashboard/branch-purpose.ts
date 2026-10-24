import type { NamedDocsBranch } from "@doxahq/contracts/docs-branches"

/**
 * The line under a branch name. A review branch and a backup branch say why
 * they exist, so they do not look like a person's own work.
 */
export function describeNamedBranch(branch: Pick<NamedDocsBranch, "purpose" | "changeCount">): string {
  switch (branch.purpose) {
    case "generation_review":
      return "Generation review · open it to decide on the changes"
    case "generation_backup":
      return "Backup of your pages from before a generation"
    case "user":
      return branch.changeCount > 0
        ? `${branch.changeCount} unpublished ${branch.changeCount === 1 ? "change" : "changes"}`
        : "No changes yet"
  }
}
