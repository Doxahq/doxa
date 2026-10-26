import {
  DOXABOT_INSTRUCTION_LIMITS,
  doxabotInstructionsSchema,
  type DoxabotCodeLanguage,
  type DoxabotInstructions,
  type DoxabotPageType,
} from "@doxahq/contracts/doxabot-instructions"

/**
 * Pure helpers for the Doxabot instructions editor: option labels, list
 * edits, and the clean-up and check that run before a save.
 */

export interface Option<T extends string> {
  value: T
  label: string
}

export const READER_OPTIONS: readonly Option<DoxabotInstructions["audience"]["reader"]>[] = [
  { value: "developers", label: "Developers" },
  { value: "internal", label: "Internal team" },
  { value: "end_users", label: "End users" },
  { value: "mixed", label: "Mixed" },
]

export const LEVEL_OPTIONS: readonly Option<DoxabotInstructions["audience"]["level"]>[] = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "expert", label: "Expert" },
]

export const TONE_OPTIONS: readonly Option<DoxabotInstructions["voice"]["tone"]>[] = [
  { value: "neutral", label: "Neutral" },
  { value: "friendly", label: "Friendly" },
  { value: "formal", label: "Formal" },
]

export const ADDRESS_OPTIONS: readonly Option<DoxabotInstructions["voice"]["address"]>[] = [
  { value: "second_person", label: "“you”" },
  { value: "first_person_plural", label: "“we”" },
]

/** Adds a language at the end, or removes it. The first one stays first. */
export function toggleCodeLanguage(
  languages: readonly DoxabotCodeLanguage[],
  language: DoxabotCodeLanguage,
): DoxabotCodeLanguage[] {
  if (languages.includes(language)) return languages.filter((item) => item !== language)
  if (languages.length >= DOXABOT_INSTRUCTION_LIMITS.codeLanguages) return [...languages]
  return [...languages, language]
}

export function togglePageType(
  pageTypes: readonly DoxabotPageType[],
  pageType: DoxabotPageType,
): DoxabotPageType[] {
  return pageTypes.includes(pageType)
    ? pageTypes.filter((item) => item !== pageType)
    : [...pageTypes, pageType]
}

export function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, position) => (position === index ? value : item))
}

export function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, position) => position !== index)
}

/** Splits "org, organization" into terms. */
export function parseTermList(value: string): string[] {
  return value.split(",").map((term) => term.trim()).filter(Boolean)
}

/** Drops empty rules and term rows the editor keeps while someone types. */
export function withoutBlankEntries(instructions: DoxabotInstructions): DoxabotInstructions {
  return {
    ...instructions,
    rules: instructions.rules.map((rule) => rule.trim()).filter(Boolean),
    terminology: instructions.terminology
      .map((entry) => ({ use: entry.use.trim(), avoid: entry.avoid.map((term) => term.trim()).filter(Boolean) }))
      .filter((entry) => entry.use.length > 0 || entry.avoid.length > 0),
  }
}

export type InstructionsCheck =
  | { ok: true; instructions: DoxabotInstructions }
  | { ok: false; message: string }

/** Runs the same schema the API runs, so the editor explains a problem before the save. */
export function checkInstructions(draft: DoxabotInstructions): InstructionsCheck {
  const parsed = doxabotInstructionsSchema.safeParse(withoutBlankEntries(draft))
  if (parsed.success) return { ok: true, instructions: parsed.data }

  const issue = parsed.error.issues[0]
  const where = issue?.path.length ? `${describePath(issue.path)}: ` : ""
  return { ok: false, message: `${where}${issue?.message ?? "Check the instructions."}` }
}

/** True when two instruction sets say the same thing. */
export function sameInstructions(a: DoxabotInstructions, b: DoxabotInstructions): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function canonical(instructions: DoxabotInstructions) {
  return [
    instructions.audience.reader,
    instructions.audience.level,
    instructions.voice.tone,
    instructions.voice.address,
    instructions.codeLanguages,
    instructions.terminology.map((entry) => [entry.use, entry.avoid]),
    instructions.pageTypes,
    instructions.doNotDocument,
    instructions.rules,
    instructions.context,
    instructions.repositoryFile.enabled,
  ]
}

const FIELD_NAMES: Record<string, string> = {
  terminology: "Terminology",
  doNotDocument: "Do not document",
  rules: "Writing rules",
  context: "Project context",
  codeLanguages: "Code examples",
  pageTypes: "Page types",
}

function describePath(path: readonly PropertyKey[]): string {
  const [field, index] = path
  const name = FIELD_NAMES[String(field)] ?? String(field)
  return typeof index === "number" ? `${name} ${index + 1}` : name
}
