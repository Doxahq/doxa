import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"

import { GenerationCancelDialog } from "~/components/dashboard/generation-cancel-dialog"

const baseProps = {
  isCancelling: false,
  error: null,
  onCancel: async () => true,
  onReset: vi.fn(),
}

describe("generation cancel dialog", () => {
  test("renders a dialog trigger only for active generations", () => {
    const active = renderToStaticMarkup(createElement(GenerationCancelDialog, {
      ...baseProps,
      canCancel: true,
    }))
    const terminal = renderToStaticMarkup(createElement(GenerationCancelDialog, {
      ...baseProps,
      canCancel: false,
    }))

    expect(active).toContain("Cancel generation")
    expect(active).toContain('aria-haspopup="dialog"')
    expect(terminal).toBe("")
  })
})
