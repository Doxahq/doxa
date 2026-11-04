// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { NotFoundPage } from "~/components/navigation/not-found-page"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/a-missing-page" }),
}))

afterEach(cleanup)

describe("NotFoundPage", () => {
  test("names the problem and links back to the home page", () => {
    render(<NotFoundPage />)

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Page not found")
    expect(screen.getByRole("link", { name: /back to home/i }).getAttribute("href")).toBe("/")
  })

  test("shows the path that was requested", () => {
    render(<NotFoundPage />)

    expect(screen.getByText("GET /a-missing-page")).toBeTruthy()
  })

  test("does not add a second main landmark inside a layout that has one", () => {
    const { container } = render(<NotFoundPage />)

    expect(container.querySelector("main")).toBeNull()
  })
})
