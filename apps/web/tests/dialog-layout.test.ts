import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import {
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "~/components/ui/dialog"

describe("dialog layout", () => {
  test("separates the title, content, and actions into consistently spaced regions", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(
          DialogHeader,
          null,
          createElement("h2", null, "Cancel generation?"),
        ),
        createElement(
          DialogBody,
          null,
          createElement("p", null, "The dialog content."),
        ),
        createElement(DialogFooter, null, createElement("button", null, "Confirm")),
      ),
    )

    expect(markup).toContain("border-b")
    expect(markup).toContain("px-6 py-5")
    expect(markup).toContain("border-t")
  })
})
