import { describe, expect, test } from "vitest"

import {
  DEFAULT_REDIRECT_PATH,
  MAX_REDIRECT_LENGTH,
  sanitizeRedirectPath,
} from "~/lib/auth/safe-redirect"

const ORIGIN = "https://doxa.so"

function sanitize(value: unknown): string {
  return sanitizeRedirectPath(value, ORIGIN)
}

describe("sanitizeRedirectPath", () => {
  test.each([
    "/oauth/consent?id=abc",
    "/dashboard/projects/123?tab=settings#top",
    "/dashboard",
    "/oauth/consent?id=a%2Fb",
  ])("keeps the same-origin path %s", (path) => {
    expect(sanitize(path)).toBe(path)
  })

  test("keeps the path, search, and hash of a same-origin full URL", () => {
    expect(sanitize("https://doxa.so/oauth/consent?id=abc#x")).toBe("/oauth/consent?id=abc#x")
  })

  test.each([
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with path", "//evil.com/oauth/consent"],
    ["other origin", "https://evil.com"],
    ["other origin with a path", "https://evil.com/dashboard"],
    ["same host, other scheme", "http://doxa.so/dashboard"],
    ["look-alike host", "https://doxa.so.evil.com/dashboard"],
    ["credentials in a same-origin URL", "https://user:pass@doxa.so/dashboard"],
    ["backslash", "/\\evil.com"],
    ["backslash later in the path", "/dashboard\\..\\evil"],
    ["only backslashes", "\\\\evil.com"],
    ["encoded slashes", "/%2F%2Fevil.com"],
    ["encoded slashes, lower case", "/%2f%2fevil.com"],
    ["encoded backslash", "/%5Cevil.com"],
    ["double-encoded slashes", "/%252F%252Fevil.com"],
    ["broken escape", "/%E0%A4%A"],
    ["javascript scheme", "javascript:alert(1)"],
    ["javascript scheme with spaces", " javascript:alert(1)"],
    ["data scheme", "data:text/html,hi"],
    ["relative without slash", "dashboard"],
    ["tab inside", "/\t/evil.com"],
    ["new line inside", "/dash\nboard"],
    ["encoded new line", "/%0A/evil.com"],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(sanitize(value)).toBe(DEFAULT_REDIRECT_PATH)
  })

  test.each([undefined, null, 42, { path: "/dashboard" }, ["/dashboard"]])(
    "rejects the non-string value %j",
    (value) => {
      expect(sanitize(value)).toBe(DEFAULT_REDIRECT_PATH)
    },
  )

  test("rejects a value over the length limit", () => {
    const path = `/${"a".repeat(MAX_REDIRECT_LENGTH)}`
    expect(sanitize(path)).toBe(DEFAULT_REDIRECT_PATH)
    expect(sanitize(path.slice(0, MAX_REDIRECT_LENGTH))).toBe(path.slice(0, MAX_REDIRECT_LENGTH))
  })

  test("rejects a full URL when the origin is unknown", () => {
    expect(sanitizeRedirectPath("https://doxa.so/dashboard", null)).toBe(DEFAULT_REDIRECT_PATH)
    expect(sanitizeRedirectPath("/oauth/consent?id=abc", null)).toBe("/oauth/consent?id=abc")
  })
})
