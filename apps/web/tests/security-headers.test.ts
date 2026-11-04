import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

import { SECURITY_HEADERS, withSecurityHeaders } from "../config/security-headers.js"

/** SECURITY REGRESSION GUARDRAIL (SEC-011): every doxa.so page sends these headers. */
describe("doxa.so security headers", () => {
  test("public/_headers sends the same headers to static files", () => {
    const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
    const lines = file
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim())

    expect(new Set(lines)).toEqual(
      new Set(Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`)),
    )
  })

  test("adds every header to a rendered response and keeps a route's own value", async () => {
    const response = withSecurityHeaders(
      new Response("page", {
        status: 201,
        headers: { "content-security-policy": "frame-ancestors 'none'", "content-type": "text/html" },
      }),
    )

    expect(response.status).toBe(201)
    expect(await response.text()).toBe("page")
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
  })
})
