import type { DoxabotInstructions } from "@doxahq/contracts/doxabot-instructions"

import type { InstructionsUpdate } from "~/lib/dashboard/use-doxabot-instructions"

/** What every editor section takes: the shown instructions, a way to change them, and read-only mode. */
export interface InstructionsSectionProps {
  instructions: DoxabotInstructions
  update: (change: InstructionsUpdate) => void
  disabled: boolean
}

/** A field id unique to the editor, for labels. */
export const fieldId = (name: string) => `doxabot-instructions-${name}`

/** "3 of 10", for the counters beside a section title. */
export function countLabel(count: number, max: number): string {
  return `${count} of ${max}`
}
