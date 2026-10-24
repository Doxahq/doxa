import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"

vi.mock("@tanstack/react-router", async () => {
  const { createElement: createReactElement } = await import("react")

  return {
    Link: ({
      children,
      to,
      params,
    }: {
      children?: import("react").ReactNode
      to: string
      params?: { projectId?: string }
    }) => createReactElement("a", {
      "data-to": to,
      "data-project-id": params?.projectId,
    }, children),
  }
})

import {
  GenerationsBackNavigation,
  PageBackNavigation,
  ProjectsBackNavigation,
} from "~/components/dashboard/page-back-navigation"

describe("page back navigation", () => {
  test("renders a compact, left-aligned navigation control for page content", () => {
    const markup = renderToStaticMarkup(
      createElement(
        PageBackNavigation,
        null,
        createElement("a", { href: "/dashboard/projects" }, "Projects"),
      ),
    )

    expect(markup).toContain('<nav aria-label="Back navigation" class="self-start">')
    expect(markup).toContain('href="/dashboard/projects"')
    expect(markup).toContain("Projects")
  })

  test("links project pages back to the projects list", () => {
    const markup = renderToStaticMarkup(createElement(ProjectsBackNavigation))

    expect(markup).toContain('data-to="/dashboard/projects"')
    expect(markup).toContain("Projects")
  })

  test("links generation detail pages back to their project generations", () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationsBackNavigation, { projectId: "project-1" }),
    )

    expect(markup).toContain('data-to="/dashboard/projects/$projectId/generations"')
    expect(markup).toContain('data-project-id="project-1"')
    expect(markup).toContain("Generations")
  })
})
