import { describe, expect, test, vi } from "vitest"

import { AnalyticsController, analyticsSwitchOn, shouldShowConsentPrompt } from "~/lib/analytics/analytics-controller"
import { scrubCaptureResult, urlHoldsSecret } from "~/lib/analytics/posthog-options"
import { FakePostHog } from "./support/fake-posthog"

const CONNECTION = { key: "phc_test_key", apiHost: "https://e.example.test", uiHost: "https://us.posthog.com" }

function setup(sdk = new FakePostHog()) {
  const loadSdk = vi.fn(async () => sdk)
  const controller = new AnalyticsController({ loadSdk, tracingHosts: ["api.example.test"] })
  return { controller, sdk, loadSdk }
}

function initConfig(sdk: FakePostHog) {
  const init = sdk.calls.find((call) => call.method === "init")
  if (!init || init.method !== "init") throw new Error("posthog-js did not start")
  return init.config
}

describe("analytics controller", () => {
  test("nothing loads until both the config answer and the stored choice are known", async () => {
    const { controller, loadSdk } = setup()
    controller.setConfig({ consentRequired: false, connection: CONNECTION })
    await controller.settled()
    expect(loadSdk).not.toHaveBeenCalled()
    controller.setChoice(null)
    await controller.settled()
    expect(loadSdk).toHaveBeenCalledTimes(1)
  })

  test("outside the EEA and the UK it starts in full mode with the cookie, replay and masking", async () => {
    const { controller, sdk } = setup()
    controller.setChoice(null)
    controller.setConfig({ consentRequired: false, connection: CONNECTION })
    await controller.settled()
    expect(controller.currentMode()).toBe("full")
    const config = initConfig(sdk)
    expect(config).toMatchObject({
      api_host: CONNECTION.apiHost,
      ui_host: CONNECTION.uiHost,
      defaults: "2026-08-30",
      person_profiles: "identified_only",
      respect_dnt: true,
      capture_exceptions: true,
      tracing_headers: ["api.example.test"],
      mask_all_text: true,
      mask_all_element_attributes: true,
      persistence: "cookie",
      disable_session_recording: false,
      session_recording: { maskAllInputs: true, maskTextSelector: "*", recordHeaders: false, recordBody: false },
    })
  })

  test("pending consent runs anonymous: memory only, no replay, no autocapture, no events", async () => {
    const { controller, sdk } = setup()
    controller.setChoice(null)
    controller.setConfig({ consentRequired: true, connection: CONNECTION })
    await controller.settled()
    expect(controller.currentMode()).toBe("anonymous")
    expect(initConfig(sdk)).toMatchObject({ persistence: "memory", disable_session_recording: true, autocapture: false })
    controller.capture("cta_clicked", { location: "home_hero", cta: "get_started" })
    expect(sdk.methods()).not.toContain("capture")
  })

  test("Accept moves anonymous to full without a reload, then identify links the person once", async () => {
    const { controller, sdk } = setup()
    controller.setChoice(null)
    controller.setConfig({ consentRequired: true, connection: CONNECTION })
    controller.update({ person: { id: "user-1", email: "ada@example.test" } })
    await controller.settled()
    expect(sdk.methods()).not.toContain("identify")

    controller.setChoice("granted")
    expect(controller.currentMode()).toBe("full")
    expect(sdk.calls).toContainEqual({
      method: "set_config",
      config: expect.objectContaining({ persistence: "cookie", disable_session_recording: false }),
    })
    expect(sdk.calls).toContainEqual({ method: "identify", distinctId: "user-1", properties: { email: "ada@example.test" } })

    controller.update({ person: { id: "user-1", email: "ada@example.test" } })
    expect(sdk.methods().filter((method) => method === "identify")).toHaveLength(1)
    expect(sdk.methods().filter((method) => method === "init")).toHaveLength(1)
  })

  test("Reject opts out; a later Accept opts in again", async () => {
    const { controller, sdk } = setup()
    controller.setChoice(null)
    controller.setConfig({ consentRequired: false, connection: CONNECTION })
    await controller.settled()

    controller.setChoice("denied")
    expect(controller.currentMode()).toBe("off")
    expect(sdk.optedOut).toBe(true)
    controller.capture("cta_clicked", { location: "nav", cta: "get_started" })
    expect(sdk.methods()).not.toContain("capture")

    controller.setChoice("granted")
    expect(controller.currentMode()).toBe("full")
    expect(sdk.optedOut).toBe(false)
  })

  test("a stored Reject never loads posthog-js", async () => {
    const { controller, loadSdk } = setup()
    controller.setChoice("denied")
    controller.setConfig({ consentRequired: false, connection: CONNECTION })
    await controller.settled()
    expect(loadSdk).not.toHaveBeenCalled()
    expect(controller.currentMode()).toBe("off")
  })

  test("no connection (an unset key) never loads posthog-js", async () => {
    const { controller, loadSdk } = setup()
    controller.setChoice("granted")
    controller.setConfig({ consentRequired: false, connection: null })
    await controller.settled()
    expect(loadSdk).not.toHaveBeenCalled()
  })

  test("an account opt-out wins over a local Accept, and nothing starts while the account loads", async () => {
    const { controller, sdk, loadSdk } = setup()
    controller.update({ accountOptedOut: null })
    controller.setChoice("granted")
    controller.setConfig({ consentRequired: false, connection: CONNECTION })
    await controller.settled()
    expect(loadSdk).not.toHaveBeenCalled()

    controller.update({ accountOptedOut: false })
    await controller.settled()
    expect(controller.currentMode()).toBe("full")

    controller.update({ accountOptedOut: true })
    expect(controller.currentMode()).toBe("off")
    expect(sdk.optedOut).toBe(true)
  })

  test("a stored posthog-js opt-out from an earlier visit loses to today's Accept", async () => {
    const { controller, sdk } = setup(new FakePostHog({ optedOut: true }))
    controller.setChoice("granted")
    controller.setConfig({ consentRequired: true, connection: CONNECTION })
    await controller.settled()
    expect(sdk.optedOut).toBe(false)
  })

  test("events wait while posthog-js loads, then send in full mode", async () => {
    const { controller, sdk } = setup()
    controller.setChoice(null)
    controller.setConfig({ consentRequired: false, connection: CONNECTION })
    controller.capture("cta_clicked", { location: "home_hero", cta: "get_started" })
    await controller.settled()
    expect(sdk.calls).toContainEqual({
      method: "capture",
      eventName: "cta_clicked",
      properties: { location: "home_hero", cta: "get_started" },
    })
  })

  test("sign-out resets the person only in full mode", async () => {
    const { controller, sdk } = setup()
    controller.setChoice("granted")
    controller.setConfig({ consentRequired: true, connection: CONNECTION })
    controller.update({ person: { id: "user-1", email: null } })
    await controller.settled()
    expect(sdk.calls).toContainEqual({ method: "identify", distinctId: "user-1", properties: undefined })
    controller.signOut()
    expect(sdk.methods()).toContain("reset")
    expect(controller.getSnapshot().person).toBeNull()
  })

  test("a failed load leaves analytics off and never throws", async () => {
    const controller = new AnalyticsController({
      loadSdk: () => Promise.reject(new Error("blocked")),
      tracingHosts: [],
    })
    controller.setChoice("granted")
    controller.setConfig({ consentRequired: false, connection: CONNECTION })
    await expect(controller.settled()).resolves.toBeUndefined()
    expect(controller.currentMode()).toBeNull()
  })

  test("the server never loads posthog-js", async () => {
    const loadSdk = vi.fn(async () => new FakePostHog())
    const controller = new AnalyticsController({ loadSdk, tracingHosts: [], isBrowser: false })
    controller.setChoice("granted")
    controller.setConfig({ consentRequired: false, connection: CONNECTION })
    await controller.settled()
    expect(loadSdk).not.toHaveBeenCalled()
  })
})

describe("consent prompt and switch", () => {
  const base = { connection: CONNECTION, configLoaded: true, choiceLoaded: true, person: null } as const

  test("the banner shows only when consent is required, nothing decides yet, and analytics is on", () => {
    expect(shouldShowConsentPrompt({ ...base, consentRequired: true, choice: null, accountOptedOut: false })).toBe(true)
    expect(shouldShowConsentPrompt({ ...base, consentRequired: false, choice: null, accountOptedOut: false })).toBe(false)
    expect(shouldShowConsentPrompt({ ...base, consentRequired: true, choice: "denied", accountOptedOut: false })).toBe(false)
    expect(shouldShowConsentPrompt({ ...base, consentRequired: true, choice: null, accountOptedOut: true })).toBe(false)
    expect(shouldShowConsentPrompt({ ...base, consentRequired: true, choice: null, accountOptedOut: null })).toBe(false)
    expect(shouldShowConsentPrompt({ ...base, connection: null, consentRequired: true, choice: null, accountOptedOut: false })).toBe(false)
    expect(shouldShowConsentPrompt({ ...base, choiceLoaded: false, consentRequired: true, choice: null, accountOptedOut: false })).toBe(false)
  })

  test("the Privacy choices switch follows the choice, the region and the account", () => {
    expect(analyticsSwitchOn({ ...base, consentRequired: false, choice: null, accountOptedOut: false })).toBe(true)
    expect(analyticsSwitchOn({ ...base, consentRequired: true, choice: null, accountOptedOut: false })).toBe(false)
    expect(analyticsSwitchOn({ ...base, consentRequired: true, choice: "granted", accountOptedOut: false })).toBe(true)
    expect(analyticsSwitchOn({ ...base, consentRequired: false, choice: "granted", accountOptedOut: true })).toBe(false)
  })
})

describe("before_send scrubbing", () => {
  test("tokens and page titles never leave, in properties, $set and $set_once", () => {
    const scrubbed = scrubCaptureResult(
      {
        uuid: "1",
        event: "$pageview",
        properties: { $current_url: "https://doxa.so/invite/secret-token?token=abc&utm_source=x", $title: "Acme docs" },
        $set: { $current_url: "https://doxa.so/reset-password?token=abc" },
        $set_once: { $initial_referrer: "https://doxa.so/approve/req-1" },
      },
      "https://doxa.so/",
    )
    expect(scrubbed?.properties).toEqual({ $current_url: "https://doxa.so/invite/:token?utm_source=x" })
    expect(scrubbed?.$set).toEqual({ $current_url: "https://doxa.so/reset-password" })
    expect(scrubbed?.$set_once).toEqual({ $initial_referrer: "https://doxa.so/approve/:requestId" })
  })

  test("a replay batch recorded on a page whose address holds a secret is dropped", () => {
    const snapshot = { uuid: "2", event: "$snapshot", properties: {} }
    expect(scrubCaptureResult(snapshot, "https://doxa.so/reset-password?token=abc")).toBeNull()
    expect(scrubCaptureResult(snapshot, "https://doxa.so/dashboard#payg")).not.toBeNull()
    expect(urlHoldsSecret("https://doxa.so/invite/abc")).toBe(true)
    expect(urlHoldsSecret("https://doxa.so/pricing?utm_source=x")).toBe(false)
  })
})
