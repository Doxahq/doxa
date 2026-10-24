import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requestHeaders: new Headers(),
}))

// The server function runs its handler directly, outside TanStack Start.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: <T>(handler: () => Promise<T>) => handler,
  }),
}))

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://doxa.so/login", { headers: mocks.requestHeaders }),
}))

async function loadDashboardSession() {
  vi.resetModules()
  const { getDashboardSession } = await import("~/server/dashboard-session")
  const { getApiUrl } = await import("~/lib/platform-api")
  return { getDashboardSession, getApiUrl }
}

describe("getDashboardSession", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DEV_USER_ID", "")
    mocks.requestHeaders = new Headers({ cookie: "better-auth.session_token=token" })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test("reads the signed-in user from GET /me with the request cookie", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({ user: { id: "user-1", email: "ada@example.com" } }),
    )
    vi.stubGlobal("fetch", fetch)
    const { getDashboardSession, getApiUrl } = await loadDashboardSession()

    await expect(getDashboardSession()).resolves.toEqual({
      user: { id: "user-1", name: null, email: "ada@example.com", image: null },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe(getApiUrl("/me"))
    expect(new Headers(init?.headers).get("cookie")).toBe("better-auth.session_token=token")
  })

  test("returns null when the API answers 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Authentication required." } }, { status: 401 })))
    const { getDashboardSession } = await loadDashboardSession()

    await expect(getDashboardSession()).resolves.toBeNull()
  })

  test("returns null for a response of the wrong shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ identity: { isAdmin: false, user: null } })))
    const { getDashboardSession } = await loadDashboardSession()

    await expect(getDashboardSession()).resolves.toBeNull()
  })

  test("returns the local development user without a request", async () => {
    vi.stubEnv("VITE_DEV_USER_ID", "local-dev-user")
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { getDashboardSession } = await loadDashboardSession()

    await expect(getDashboardSession()).resolves.toEqual({
      user: { id: "local-dev-user", name: "Dev User", email: "local-dev-user", image: null },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
