// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  navigate: vi.fn(),
  href: "/dashboard/projects/p1/content?page=%2Fguide",
}))

vi.mock("@doxahq/auth/client", () => ({
  authClient: { getSession: mocks.getSession, signOut: vi.fn() },
}))

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: mocks.navigate, state: { location: { href: mocks.href } } }),
}))

const { DashboardAuthProvider, useDashboardAuth } = await import("~/lib/auth/dashboard-auth-context")

afterEach(() => {
  cleanup()
  mocks.getSession.mockReset()
  mocks.navigate.mockReset()
})

function Identity() {
  const { user, isPending } = useDashboardAuth()
  return <p>{isPending ? "pending" : (user?.email ?? "none")}</p>
}

type ProviderProps = Parameters<typeof DashboardAuthProvider>[0]

function renderShell(
  devSession: ProviderProps["devSession"] = null,
  identityHint: ProviderProps["identityHint"] = null,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>
      <DashboardAuthProvider devSession={devSession} identityHint={identityHint}>{children}</DashboardAuthProvider>
    </QueryClientProvider>
  )
  return render(wrap(<Identity />))
}

describe("DashboardAuthProvider", () => {
  test("loads the identity from the Better Auth session in the browser", async () => {
    mocks.getSession.mockResolvedValue({
      data: { user: { id: "u1", email: "ada@example.com", name: "Ada", image: "https://img" }, session: {} },
      error: null,
    })
    renderShell()

    expect(screen.getByText("pending")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("ada@example.com")).toBeTruthy())
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  test("sends a person with an unknown session to the login page, back to the same page", async () => {
    mocks.getSession.mockResolvedValue({ data: null, error: null })
    renderShell()

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/login",
      search: { redirect: mocks.href },
      replace: true,
    })
  })

  test("a 401 from the session endpoint also goes to the login page", async () => {
    mocks.getSession.mockResolvedValue({ data: null, error: { status: 401, message: "Unauthorized" } })
    renderShell()

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1))
  })

  test("a failed session request keeps the person in the dashboard", async () => {
    mocks.getSession.mockResolvedValue({ data: null, error: { status: 503, message: "Unavailable" } })
    renderShell()

    await waitFor(() => expect(screen.getByText("none")).toBeTruthy())
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  test("the cookie's display identity shows from the first render, then the session confirms it", async () => {
    let answer!: (value: unknown) => void
    mocks.getSession.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderShell(null, { id: "u1", email: "ada@example.com", name: null, image: null })

    expect(screen.getByText("ada@example.com")).toBeTruthy()
    answer({ data: { user: { id: "u1", email: "ada@new.example.com" }, session: {} }, error: null })
    await waitFor(() => expect(screen.getByText("ada@new.example.com")).toBeTruthy())
  })

  test("the display identity never keeps a refused session in the dashboard", async () => {
    mocks.getSession.mockResolvedValue({ data: null, error: null })
    renderShell(null, { id: "u1", email: "ada@example.com", name: null, image: null })

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1))
  })

  test("the local development user needs no request", () => {
    renderShell({
      user: { id: "local-dev-user", name: "Dev User", email: "local-dev-user", image: null },
    })

    expect(screen.getByText("local-dev-user")).toBeTruthy()
    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
