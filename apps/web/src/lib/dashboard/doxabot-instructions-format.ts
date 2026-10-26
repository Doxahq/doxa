import type { DoxabotInstructionsVersionSummary } from "@doxahq/contracts/doxabot-instructions"

/** "Edited by Ada · Oct 25, 14:02", or without a name when the author left. */
export function formatInstructionsAuthor(version: DoxabotInstructionsVersionSummary): string {
  const when = new Date(version.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  const who = version.createdBy?.name
  return who ? `Edited by ${who} · ${when}` : `Edited ${when}`
}
