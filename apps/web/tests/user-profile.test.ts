import { describe, expect, test } from "vitest"

import { userAvatarUrl, userDisplayName } from "~/lib/auth/user-profile"
import { toAuthSessionUser } from "~/lib/queries/auth-session"

const GOOGLE_PICTURE = "https://lh3.googleusercontent.com/a/ada"

describe("the profile of the signed-in person", () => {
  test("a linked GitHub account wins over the sign-up provider's picture", () => {
    expect(userAvatarUrl({ image: GOOGLE_PICTURE, githubLogin: "ada-l" })).toBe(
      "https://avatars.githubusercontent.com/ada-l?size=64",
    )
  })

  test("with no GitHub account, the picture of the provider the person signed up with", () => {
    expect(userAvatarUrl({ image: GOOGLE_PICTURE, githubLogin: null })).toBe(GOOGLE_PICTURE)
  })

  test("no picture, or one that is not a plain https URL, shows initials", () => {
    expect(userAvatarUrl({})).toBeNull()
    expect(userAvatarUrl({ image: "http://example.com/a.png" })).toBeNull()
    expect(userAvatarUrl({ image: "javascript:alert(1)" })).toBeNull()
    expect(userAvatarUrl({ image: "not a url" })).toBeNull()
  })

  test("a value that is not a GitHub login never becomes a URL path", () => {
    expect(userAvatarUrl({ githubLogin: "../u/1", image: GOOGLE_PICTURE })).toBe(GOOGLE_PICTURE)
    expect(userAvatarUrl({ githubLogin: "-ada" })).toBeNull()
    expect(userAvatarUrl({ githubLogin: "a".repeat(40) })).toBeNull()
  })

  test("the browser session carries the name and the avatar", () => {
    expect(toAuthSessionUser({ id: "u1", name: " Ada Lovelace ", email: "ada@example.com", githubLogin: "ada" })).toEqual({
      id: "u1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      image: "https://avatars.githubusercontent.com/ada?size=64",
    })
  })

  test("an empty name shows nothing, so the email takes its place", () => {
    expect(userDisplayName("  ")).toBeNull()
    expect(userDisplayName(undefined)).toBeNull()
  })
})
