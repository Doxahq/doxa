// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest"

const social = vi.hoisted(() => vi.fn())
vi.mock("@doxahq/auth/client", () => ({ authClient: { signIn: { social } } }))

const { signIn } = await import("~/lib/auth/use-auth-session")

afterEach(() => vi.clearAllMocks())

describe("signIn", () => {
  test("throws when the server refuses to start the sign-in", async () => {
    social.mockResolvedValue({ data: null, error: { status: 500, message: "Internal Server Error" } })
    await expect(signIn("google", "/dashboard")).rejects.toThrow("Internal Server Error")
  })

  test("resolves when the server returns the provider redirect", async () => {
    social.mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2", redirect: true }, error: null })
    await expect(signIn("google", "/dashboard")).resolves.toBeUndefined()
    expect(social).toHaveBeenCalledWith({ provider: "google", callbackURL: `${window.location.origin}/dashboard` })
  })
})
