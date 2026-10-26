import { DEFAULT_DOXABOT_INSTRUCTIONS, type DoxabotInstructions } from "@doxahq/contracts/doxabot-instructions"
import { describe, expect, test } from "vitest"

import {
  checkInstructions,
  sameInstructions,
  toggleCodeLanguage,
  togglePageType,
  withoutBlankEntries,
} from "~/lib/dashboard/doxabot-instructions-model"

function instructions(overrides: Partial<DoxabotInstructions> = {}): DoxabotInstructions {
  return { ...DEFAULT_DOXABOT_INSTRUCTIONS, ...overrides }
}

describe("Doxabot instructions editor model", () => {
  test("languages keep the order they were picked, up to six", () => {
    let languages = toggleCodeLanguage([], "python")
    languages = toggleCodeLanguage(languages, "typescript")
    expect(languages).toEqual(["python", "typescript"])

    expect(toggleCodeLanguage(languages, "python")).toEqual(["typescript"])
    const full = ["typescript", "python", "go", "ruby", "java", "php"] as const
    expect(toggleCodeLanguage(full, "rust")).toEqual(full)
  })

  test("a page type toggles on and off", () => {
    expect(togglePageType(["guides"], "concepts")).toEqual(["guides", "concepts"])
    expect(togglePageType(["guides", "concepts"], "guides")).toEqual(["concepts"])
  })

  test("blank rules and empty term rows do not count", () => {
    const cleaned = withoutBlankEntries(instructions({
      rules: ["Keep pages short.", "  ", ""],
      terminology: [{ use: "", avoid: [] }, { use: " workspace ", avoid: ["org", " "] }],
    }))

    expect(cleaned.rules).toEqual(["Keep pages short."])
    expect(cleaned.terminology).toEqual([{ use: "workspace", avoid: ["org"] }])
  })

  test("the check explains a problem in the editor's words", () => {
    const result = checkInstructions(instructions({ terminology: [{ use: "workspace", avoid: [] }] }))

    expect(result).toEqual({ ok: false, message: "Terminology 1: Add at least one word to avoid." })
  })

  test("valid instructions pass the check with blank entries removed", () => {
    const result = checkInstructions(instructions({ rules: ["Keep pages short.", ""] }))

    expect(result).toMatchObject({ ok: true, instructions: { rules: ["Keep pages short."] } })
  })

  test("the same choices in a new object are not a change", () => {
    const saved = instructions({ codeLanguages: ["typescript"] })
    const draft = { ...saved, voice: { ...saved.voice } }

    expect(sameInstructions(draft, saved)).toBe(true)
    expect(sameInstructions({ ...draft, context: "New." }, saved)).toBe(false)
  })
})
