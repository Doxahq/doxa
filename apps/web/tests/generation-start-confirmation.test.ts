import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import * as confirmationDialog from "~/components/dashboard/generation-start-confirmation-dialog"
import { Dialog } from "~/components/ui/dialog"

describe("generation start confirmation", () => {
  test("offers cancel and force actions when no source changes exist", () => {
    const Content = (
      confirmationDialog as typeof confirmationDialog & {
        GenerationStartConfirmationContent?: ComponentType<{
          message: string
          isPending: boolean
          error: string | null
          onCancel: () => void
          onConfirm: () => void
        }>
      }
    ).GenerationStartConfirmationContent

    expect(Content).toBeTypeOf("function")
    if (!Content) return

    const markup = renderToStaticMarkup(
      createElement(
        Dialog,
        null,
        createElement(Content, {
          message: "The repository has not changed.",
          isPending: false,
          error: null,
          onCancel: () => undefined,
          onConfirm: () => undefined,
        }),
      ),
    )

    expect(markup).toContain("The repository has not changed.")
    expect(markup).toContain(">Cancel<")
    expect(markup).toContain(">Generate anyway<")
  })

  test("explains the review before a generation replaces editor pages", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Dialog,
        null,
        createElement(confirmationDialog.GenerationStartConfirmationContent, {
          reason: "editor_content",
          message: "This site has pages that were written in the editor.",
          isPending: false,
          error: null,
          onCancel: () => undefined,
          onConfirm: () => undefined,
        }),
      ),
    )

    expect(markup).toContain("Your site has pages written in the editor")
    expect(markup).toContain("your current pages stay in a backup branch")
    expect(markup).toContain("How generation reviews work")
    expect(markup).toContain("Use my pages as a guide")
    expect(markup).toContain("Start from my code only")
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain(">Generate for review<")
  })
})
