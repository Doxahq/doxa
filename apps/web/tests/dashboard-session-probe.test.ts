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

async function loadSignInCheck() {
  vi.resetModules()
  const { hasDashboardSignIn } = await import("~/server/dashboard-session")
  return hasDashboardSignIn
}

async function loadMarkerCheck() {
  vi.resetModules()
  const { hasSignedInMarker } = await import("~/server/dashboard-session")
  return hasSignedInMarker
}

/**
 * SECURITY REGRESSION GUARDRAIL (SEC-021): the session cookies are host-only
 * on the API host, so the dashboard server decides from cookies alone and
 * never sends the visitor's cookies on to the API.
 */
describe("hasDashboardSignIn", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DEV_USER_ID", "")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test("is true with the API's signed-in marker, without a request to the API", async () => {
    mocks.requestHeaders = new Headers({ cookie: "doxa.signed_in=1" })
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const hasDashboardSignIn = await loadSignInCheck()

    await expect(hasDashboardSignIn()).resolves.toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  test("is true with a session cookie from before host-only cookies", async () => {
    mocks.requestHeaders = new Headers({ cookie: "better-auth.session_token=token" })
    const hasDashboardSignIn = await loadSignInCheck()

    await expect(hasDashboardSignIn()).resolves.toBe(true)
  })

  test("is false without a marker or a session cookie", async () => {
    mocks.requestHeaders = new Headers({ cookie: "doxa.signed_in=; other=1" })
    const hasDashboardSignIn = await loadSignInCheck()

    await expect(hasDashboardSignIn()).resolves.toBe(false)
  })

  // The login page trusts the marker only: an old session cookie can hold a revoked session.
  test("the login check ignores a session cookie without the marker", async () => {
    mocks.requestHeaders = new Headers({ cookie: "better-auth.session_token=revoked" })
    const hasSignedInMarker = await loadMarkerCheck()

    await expect(hasSignedInMarker()).resolves.toBe(false)
  })

  test("the login check ignores a marker with another prefix", async () => {
    mocks.requestHeaders = new Headers({ cookie: "doxa-dev.signed_in=1" })
    const hasSignedInMarker = await loadMarkerCheck()

    await expect(hasSignedInMarker()).resolves.toBe(false)
  })

  test("is true for the local development user", async () => {
    vi.stubEnv("VITE_DEV_USER_ID", "local-dev-user")
    mocks.requestHeaders = new Headers()
    const hasDashboardSignIn = await loadSignInCheck()

    await expect(hasDashboardSignIn()).resolves.toBe(true)
  })
})
