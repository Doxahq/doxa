import { describe, expect, test, vi } from "vitest"

import { POSTHOG_UI_HOST } from "~/lib/analytics/analytics-config"
import { analyticsConfigResponse, requestCountry } from "~/server/analytics-config"

const FILLED = { POSTHOG_KEY: "phc_test_key", POSTHOG_INGEST_HOSTNAME: "e.example.test" }

/** A Worker request: Cloudflare adds `cf` to the incoming Request object. */
function workerRequest(country: string | null, headers: Record<string, string> = {}): Request {
  const request = new Request("https://doxa.test/api/analytics-config", { headers })
  if (country !== null) Object.defineProperty(request, "cf", { value: { country } })
  return request
}

async function answer(request: Request, env: Record<string, string | undefined> = FILLED) {
  const response = analyticsConfigResponse(request, { env, warn: () => undefined })
  return { response, body: await response.json() }
}

describe("GET /api/analytics-config", () => {
  test("a visitor in the EEA needs consent, and gets the connection", async () => {
    const { response, body } = await answer(workerRequest("DE"))
    expect(body).toEqual({
      consentRequired: true,
      posthog: { key: "phc_test_key", apiHost: "https://e.example.test", uiHost: POSTHOG_UI_HOST },
    })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  test("a visitor in the UK needs consent too", async () => {
    expect((await answer(workerRequest("GB"))).body.consentRequired).toBe(true)
  })

  test("a visitor outside the EEA and the UK needs no consent", async () => {
    expect((await answer(workerRequest("US"))).body.consentRequired).toBe(false)
  })

  test("an unknown country needs consent: no country, Cloudflare's XX, and Tor", async () => {
    expect((await answer(workerRequest(null))).body.consentRequired).toBe(true)
    expect((await answer(workerRequest("XX"))).body.consentRequired).toBe(true)
    expect((await answer(workerRequest("T1"))).body.consentRequired).toBe(true)
  })

  test("the cf-ipcountry header answers when request.cf is missing, and request.cf wins over it", () => {
    expect(requestCountry(workerRequest(null, { "cf-ipcountry": "US" }))).toBe("US")
    expect(requestCountry(workerRequest("FR", { "cf-ipcountry": "US" }))).toBe("FR")
    expect(requestCountry(workerRequest(null))).toBeNull()
  })

  test("an unset key turns analytics off and says why once", async () => {
    const warn = vi.fn()
    const response = analyticsConfigResponse(workerRequest("US"), { env: {}, warn })
    expect(await response.json()).toEqual({ consentRequired: false, posthog: null })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("POSTHOG_KEY"))
  })

  test("an unfilled ${OPS_*} placeholder turns analytics off", async () => {
    const env = { POSTHOG_KEY: "${OPS_POSTHOG_PROJECT_KEY}", POSTHOG_INGEST_HOSTNAME: "${OPS_POSTHOG_INGEST_HOSTNAME}" }
    expect((await answer(workerRequest("US"), env)).body.posthog).toBeNull()
  })

  test("a key without a hostname uses PostHog US Cloud, and a hostname with a scheme stays as it is", async () => {
    expect((await answer(workerRequest("US"), { POSTHOG_KEY: "phc_test_key" })).body.posthog.apiHost).toBe(
      "https://us.i.posthog.com",
    )
    const local = { POSTHOG_KEY: "phc_test_key", POSTHOG_INGEST_HOSTNAME: "http://localhost:8010" }
    expect((await answer(workerRequest("US"), local)).body.posthog.apiHost).toBe("http://localhost:8010")
  })
})
