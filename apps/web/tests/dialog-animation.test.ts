import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

/**
 * Dialogs appear at once, with no entrance or exit animation.
 *
 * A dialog interrupts the reader, so it must be readable in the frame it
 * appears. The `shadcn` CLI writes these animation utilities into every dialog
 * primitive it generates, so a later `shadcn add` puts them back. This test
 * reads the source, because the classes are the thing that must stay absent.
 */
const DIALOG_SOURCES = ["../src/components/ui/dialog.tsx", "../src/components/ui/sheet.tsx"]

const ANIMATION_UTILITIES = [
  "animate-in",
  "animate-out",
  "fade-in",
  "fade-out",
  "zoom-in",
  "zoom-out",
  "slide-in",
  "slide-out",
]

describe("dialog animation", () => {
  test.each(DIALOG_SOURCES)("%s declares no animation utility", (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")

    for (const utility of ANIMATION_UTILITIES) {
      expect(source).not.toContain(utility)
    }
  })

  test("no dialog keeps an opt-out flag", () => {
    // Every dialog behaves the same way. A per-dialog flag is what let some of
    // them animate and others not.
    for (const relativePath of DIALOG_SOURCES) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
      expect(source).not.toContain("disableAnimation")
    }
  })
})
