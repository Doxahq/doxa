import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"

import { ExpandableCard } from "~/components/dashboard/expandable-card"

describe("expandable card", () => {
  test("renders a native details disclosure with its open state", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ExpandableCard,
        {
          title: "Generation log",
          meta: createElement("span", null, "12 lines"),
          open: true,
          onOpenChange: vi.fn(),
          children: createElement("p", null, "Build output"),
        },
      ),
    )

    expect(markup).toContain("<details open=\"\"")
    expect(markup).toContain("Generation log")
    expect(markup).toContain("12 lines")
    expect(markup).toContain("Build output")
  })
})
