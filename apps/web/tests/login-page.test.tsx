// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, test } from "vitest"

import { LoginPage } from "~/components/auth/login-page"
import { getApiUrl } from "~/lib/platform-api"

afterEach(cleanup)

describe("LoginPage", () => {
  test("server HTML has working sign-in links before hydration", () => {
    const html = renderToString(<LoginPage redirectPath="/dashboard/projects?tab=a" errorMessage={null} />)
    const container = document.createElement("div")
    container.innerHTML = html

    const hrefs = Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"))
    expect(hrefs).toEqual([
      getApiUrl("/sign-in/github?redirect=%2Fdashboard%2Fprojects%3Ftab%3Da"),
      getApiUrl("/sign-in/google?redirect=%2Fdashboard%2Fprojects%3Ftab%3Da"),
    ])
  })

  test("a click shows a spinner and disables the other provider", () => {
    render(<LoginPage redirectPath="/dashboard" errorMessage={null} />)
    const github = screen.getByRole("link", { name: "Continue with GitHub" })
    github.addEventListener("click", (event) => event.preventDefault())

    fireEvent.click(github)

    const google = screen.getByRole("link", { name: "Continue with Google" })
    expect(github.querySelector(".animate-spin")).not.toBeNull()
    expect(google.getAttribute("aria-disabled")).toBe("true")
    expect(fireEvent.click(google)).toBe(false)
  })

  test("shows the sign-in error", () => {
    render(<LoginPage redirectPath="/dashboard" errorMessage="Sign-in is not available right now." />)

    expect(screen.getByRole("alert").textContent).toBe("Sign-in is not available right now.")
  })
})
