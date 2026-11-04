// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ForgotPasswordPage } from "~/components/auth/forgot-password-page"
import { LoginPage } from "~/components/auth/login-page"
import { ProviderButtons } from "~/components/auth/provider-buttons"
import { ResetPasswordPage } from "~/components/auth/reset-password-page"
import { SignupPage } from "~/components/auth/signup-page"
import * as emailPassword from "~/lib/auth/email-password"
import { getApiUrl } from "~/lib/platform-api"

beforeEach(() => {
  vi.spyOn(emailPassword, "signInWithEmail")
  vi.spyOn(emailPassword, "signUpWithEmail")
  vi.spyOn(emailPassword, "requestPasswordReset")
  vi.spyOn(emailPassword, "resetPassword")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The auth pages link to each other, so they render inside a router. */
async function renderPage(page: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <>{page}</> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByRole("heading")
  return router
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe("ProviderButtons", () => {
  test("server HTML has working sign-in links before hydration", () => {
    const html = renderToString(<ProviderButtons redirectPath="/dashboard/projects?tab=a" />)
    const container = document.createElement("div")
    container.innerHTML = html

    const hrefs = Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"))
    expect(hrefs).toEqual([
      getApiUrl("/sign-in/github?redirect=%2Fdashboard%2Fprojects%3Ftab%3Da"),
      getApiUrl("/sign-in/google?redirect=%2Fdashboard%2Fprojects%3Ftab%3Da"),
    ])
  })

  test("a click shows a spinner and disables the other provider", () => {
    render(<ProviderButtons redirectPath="/dashboard" />)
    const github = screen.getByRole("link", { name: "Continue with GitHub" })
    github.addEventListener("click", (event) => event.preventDefault())

    fireEvent.click(github)

    const google = screen.getByRole("link", { name: "Continue with Google" })
    expect(github.querySelector(".animate-spin")).not.toBeNull()
    expect(google.getAttribute("aria-disabled")).toBe("true")
    expect(fireEvent.click(google)).toBe(false)
  })
})

describe("LoginPage", () => {
  test("shows the sign-in error", async () => {
    await renderPage(
      <LoginPage redirectPath="/dashboard" errorMessage="Sign-in is not available right now." notice={null} />,
    )

    expect(screen.getByRole("alert").textContent).toBe("Sign-in is not available right now.")
  })

  test("has both providers, the email form, and a sign-up link that keeps the redirect", async () => {
    await renderPage(<LoginPage redirectPath="/invite/tok" errorMessage={null} notice={null} />)

    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeTruthy()
    expect(screen.getByLabelText("Email")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Forgot password?" })).toBeNull()
    expect(screen.getByRole("link", { name: "Reset password" }).getAttribute("href")).toBe("/forgot-password")
    expect(screen.getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe("/signup?redirect=%2Finvite%2Ftok")
  })

  test("an email sign-in goes to the redirect target", async () => {
    vi.mocked(emailPassword.signInWithEmail).mockResolvedValue({ ok: true })
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign })
    await renderPage(<LoginPage redirectPath="/dashboard/projects" errorMessage={null} notice={null} />)

    fill("Email", "ada@example.com")
    fill("Password", "correct horse battery")
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/dashboard/projects"))
    expect(emailPassword.signInWithEmail).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct horse battery",
      redirectPath: "/dashboard/projects",
    })
  })

  test("an unverified account sees a notice, not an error", async () => {
    vi.mocked(emailPassword.signInWithEmail).mockResolvedValue({
      ok: false,
      code: "EMAIL_NOT_VERIFIED",
      message: "Verify your email first. We sent a new link to your inbox.",
    })
    await renderPage(<LoginPage redirectPath="/dashboard" errorMessage={null} notice={null} />)

    fill("Email", "ada@example.com")
    fill("Password", "correct horse battery")
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    const status = await screen.findByRole("status")
    expect(status.textContent).toContain("Verify your email first")
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

describe("SignupPage", () => {
  test("an email sign-up ends on check your email", async () => {
    vi.mocked(emailPassword.signUpWithEmail).mockResolvedValue({ ok: true })
    await renderPage(<SignupPage redirectPath="/dashboard" />)

    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toBeTruthy()
    fill("Name", "Ada")
    fill("Email", "ada@example.com")
    fill("Password", "correct horse battery")
    fireEvent.click(screen.getByRole("button", { name: "Create account" }))

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy()
    expect(screen.getByText("ada@example.com")).toBeTruthy()
    expect(screen.queryByLabelText("Password")).toBeNull()
    expect(emailPassword.signUpWithEmail).toHaveBeenCalledWith({
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse battery",
      redirectPath: "/dashboard",
    })
  })

  test("asks for a password of at least 8 characters", async () => {
    await renderPage(<SignupPage redirectPath="/dashboard" />)

    expect(screen.getByLabelText("Password").getAttribute("minlength")).toBe("8")
  })
})

describe("ForgotPasswordPage", () => {
  test("says the same thing whether or not the address has an account", async () => {
    vi.mocked(emailPassword.requestPasswordReset).mockResolvedValue({ ok: true })
    await renderPage(<ForgotPasswordPage />)

    fill("Email", "ada@example.com")
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }))

    expect(await screen.findByText(/has a Doxa account, a reset link is on its way/)).toBeTruthy()
  })
})

describe("ResetPasswordPage", () => {
  test("refuses two different passwords without calling the API", async () => {
    await renderPage(<ResetPasswordPage token="tok" linkError={false} />)

    fill("New password", "correct horse battery")
    fill("Confirm password", "correct horse staple")
    fireEvent.click(screen.getByRole("button", { name: "Set password" }))

    expect((await screen.findByRole("alert")).textContent).toBe("The two passwords do not match.")
    expect(emailPassword.resetPassword).not.toHaveBeenCalled()
  })

  test("a used or expired link offers a new one", async () => {
    await renderPage(<ResetPasswordPage token={null} linkError />)

    expect(screen.queryByLabelText("New password")).toBeNull()
    expect(screen.getByRole("link", { name: "Ask for a new one" }).getAttribute("href")).toBe("/forgot-password")
  })

  test("a new password goes back to sign-in with a notice", async () => {
    vi.mocked(emailPassword.resetPassword).mockResolvedValue({ ok: true })
    const router = await renderPage(<ResetPasswordPage token="tok" linkError={false} />)

    fill("New password", "correct horse battery")
    fill("Confirm password", "correct horse battery")
    fireEvent.click(screen.getByRole("button", { name: "Set password" }))

    await vi.waitFor(() => expect(router.state.location.href).toBe("/login?notice=password-reset"))
    expect(emailPassword.resetPassword).toHaveBeenCalledWith("tok", "correct horse battery")
  })
})
