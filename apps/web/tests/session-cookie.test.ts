import { describe, expect, test } from "vitest"

import { resolveDashboardEntry } from "~/lib/auth/dashboard-entry"
import { hasSessionTokenCookie, readSessionCookieIdentity } from "~/lib/auth/session-cookie"

describe("hasSessionTokenCookie", () => {
  test("finds the Better Auth session token among other cookies", () => {
    expect(hasSessionTokenCookie("theme=dark; better-auth.session_token=abc.def; other=1")).toBe(true)
  })

  test("accepts the __Secure- name that Better Auth uses on https", () => {
    expect(hasSessionTokenCookie("__Secure-better-auth.session_token=abc.def")).toBe(true)
  })

  test("accepts a custom cookie prefix, such as the local development one", () => {
    expect(hasSessionTokenCookie("doxa-dev.session_token=abc", "doxa-dev")).toBe(true)
    expect(hasSessionTokenCookie("__Secure-doxa-dev.session_token=abc", "doxa-dev")).toBe(true)
  })

  test("ignores a session token with another prefix, such as production cookies on a dev host", () => {
    expect(hasSessionTokenCookie("__Secure-better-auth.session_token=abc", "doxa-dev")).toBe(false)
    expect(hasSessionTokenCookie("doxa-dev.session_token=abc")).toBe(false)
  })

  test("is false with no cookie header or no session token", () => {
    expect(hasSessionTokenCookie(null)).toBe(false)
    expect(hasSessionTokenCookie(undefined)).toBe(false)
    expect(hasSessionTokenCookie("")).toBe(false)
    expect(hasSessionTokenCookie("theme=dark; sidebar=open")).toBe(false)
  })

  test("ignores the session cache cookie, which is not a session token", () => {
    expect(hasSessionTokenCookie("__Secure-better-auth.session_data=eyJ")).toBe(false)
  })

  test("ignores an empty session token, as a sign-out leaves it", () => {
    expect(hasSessionTokenCookie("better-auth.session_token=; theme=dark")).toBe(false)
    expect(hasSessionTokenCookie("__Secure-better-auth.session_token=")).toBe(false)
  })

  test("needs the exact cookie name, not a look-alike", () => {
    expect(hasSessionTokenCookie("session_token=abc")).toBe(false)
    expect(hasSessionTokenCookie("better-auth.session_token_old=abc")).toBe(false)
    expect(hasSessionTokenCookie("x=better-auth.session_token=abc")).toBe(false)
  })
})

const NOW = Date.parse("2026-10-22T12:00:00.000Z")

/** A session cache cookie value as Better Auth's "compact" strategy writes it. */
function sessionData({
  expiresAt = NOW + 60_000,
  sessionExpiresAt = "2026-11-01T00:00:00.000Z",
  user = { id: "u1", email: "ada@example.com", name: "Ada", image: null } as Record<string, unknown>,
} = {}): string {
  const payload = {
    session: { session: { id: "s1", expiresAt: sessionExpiresAt }, user, updatedAt: NOW, version: "1" },
    expiresAt,
    signature: "not-checked",
  }
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

describe("readSessionCookieIdentity", () => {
  test("reads the id and email from a valid session cache cookie", () => {
    const header = `theme=dark; __Secure-better-auth.session_data=${sessionData()}`
    expect(readSessionCookieIdentity(header, NOW)).toEqual({ id: "u1", email: "ada@example.com" })
  })

  test("reads a cookie with a custom prefix, and one split into chunks", () => {
    expect(readSessionCookieIdentity(`doxa-dev.session_data=${sessionData()}`, NOW, "doxa-dev")?.id).toBe("u1")
    const value = sessionData()
    const header = `better-auth.session_data.1=${value.slice(40)}; better-auth.session_data.0=${value.slice(0, 40)}`
    expect(readSessionCookieIdentity(header, NOW)?.email).toBe("ada@example.com")
  })

  test("reads non-ASCII text in the user", () => {
    const value = sessionData({ user: { id: "u2", email: "zoë@example.com" } })
    expect(readSessionCookieIdentity(`better-auth.session_data=${value}`, NOW)?.email).toBe("zoë@example.com")
  })

  test("ignores an expired cache cookie", () => {
    const header = `better-auth.session_data=${sessionData({ expiresAt: NOW - 1 })}`
    expect(readSessionCookieIdentity(header, NOW)).toBeNull()
  })

  test("ignores a cookie whose session has ended", () => {
    const header = `better-auth.session_data=${sessionData({ sessionExpiresAt: "2026-10-22T11:59:59.000Z" })}`
    expect(readSessionCookieIdentity(header, NOW)).toBeNull()
  })

  test("ignores a malformed cookie", () => {
    expect(readSessionCookieIdentity("better-auth.session_data=%%%not-base64", NOW)).toBeNull()
    const notJson = Buffer.from("not json").toString("base64url")
    expect(readSessionCookieIdentity(`better-auth.session_data=${notJson}`, NOW)).toBeNull()
    const noUser = Buffer.from(JSON.stringify({ session: {}, expiresAt: NOW + 1 })).toString("base64url")
    expect(readSessionCookieIdentity(`better-auth.session_data=${noUser}`, NOW)).toBeNull()
  })

  test("is null with no cache cookie", () => {
    expect(readSessionCookieIdentity(null, NOW)).toBeNull()
    expect(readSessionCookieIdentity("better-auth.session_token=abc", NOW)).toBeNull()
  })

  test("ignores a cache cookie with another prefix", () => {
    expect(readSessionCookieIdentity(`better-auth.session_data=${sessionData()}`, NOW, "doxa-dev")).toBeNull()
  })
})

describe("resolveDashboardEntry", () => {
  test("no session token: the login page", () => {
    expect(resolveDashboardEntry(`better-auth.session_data=${sessionData()}`, null, NOW)).toBeNull()
  })

  test("a session token with a valid cache cookie gives the display identity", () => {
    const header = `__Secure-better-auth.session_token=abc; __Secure-better-auth.session_data=${sessionData()}`
    expect(resolveDashboardEntry(header, null, NOW)).toEqual({
      devSession: null,
      identityHint: { id: "u1", email: "ada@example.com", name: null, image: null },
    })
  })

  test("a session token without a usable cache cookie renders the shell with no identity", () => {
    const expired = `better-auth.session_token=abc; better-auth.session_data=${sessionData({ expiresAt: NOW - 1 })}`
    expect(resolveDashboardEntry(expired, null, NOW)).toEqual({ devSession: null, identityHint: null })
    expect(resolveDashboardEntry("better-auth.session_token=abc", null, NOW)).toEqual({
      devSession: null,
      identityHint: null,
    })
  })

  test("the local development user needs no cookie", () => {
    const devSession = { user: { id: "dev", name: "Dev User", email: "dev", image: null } }
    expect(resolveDashboardEntry(null, devSession, NOW)).toEqual({ devSession, identityHint: null })
  })
})
