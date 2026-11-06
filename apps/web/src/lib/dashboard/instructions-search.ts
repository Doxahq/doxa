/** What the instructions page does after a save. */
export type InstructionsThen = "generate"

export interface InstructionsSearch {
  then?: InstructionsThen
}

/**
 * `?then=generate` opens the instructions page as a step before a generation,
 * with "Save and start generation". Any other value opens the plain editor.
 */
export function parseInstructionsSearch(search: Record<string, unknown>): InstructionsSearch {
  return search.then === "generate" ? { then: search.then } : {}
}
