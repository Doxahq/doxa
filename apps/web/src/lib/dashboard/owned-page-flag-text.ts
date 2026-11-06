import type { OwnedPageFlag } from "@doxahq/contracts/generation-reviews"

/** The short line under a locked page in the review list. */
export function ownedPageFlagSummary(flag: OwnedPageFlag): string {
  if (flag.removed) return "Not in the new plan"
  const reasons = [
    ...(flag.changedPaths.length > 0
      ? [flag.changedPaths.length === 1 ? "1 source file changed" : `${flag.changedPaths.length} source files changed`]
      : []),
    ...(flag.instructionsChanged ? ["instructions changed"] : []),
  ]
  return reasons.join(", ")
}

/** What the review tells the owner of a locked page that the run kept or left out. */
export function ownedPageFlagNotice(flag: OwnedPageFlag): string {
  if (flag.removed) {
    return "You own this page, but the new plan has no page for it, so the generation left it out. Restore it if you want to keep it."
  }
  const sentences = ["You own this page, so the generation kept it."]
  if (flag.changedPaths.length > 0) sentences.push(`Its code changed: ${flag.changedPaths.join(", ")}.`)
  if (flag.instructionsChanged) sentences.push("It may not follow the current Doxabot instructions.")
  sentences.push("Check that it is still right.")
  return sentences.join(" ")
}
