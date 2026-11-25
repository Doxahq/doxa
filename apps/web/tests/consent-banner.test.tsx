// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ConsentBanner } from "~/components/analytics/consent-banner"
import { browserAnalytics } from "~/lib/analytics/browser-analytics"
import { renderInRouter } from "./fixtures/render-in-router"

const CONNECTION = { key: "phc_test_key", apiHost: "https://e.example.test", uiHost: "https://us.posthog.com" }

// The page's controller, with a fake posthog-js: the banner reads it and the buttons write to it.
const harness = vi.hoisted(() => ({ choices: [] as string[] }))
vi.mock("~/lib/analytics/browser-analytics", async () => {
  const { AnalyticsController: Controller } = await import("~/lib/analytics/analytics-controller")
  const { FakePostHog: Fake } = await import("./support/fake-posthog")
  const controller = new Controller({ loadSdk: async () => new Fake(), tracingHosts: [] })
  return {
    browserAnalytics: controller,
    setAnalyticsConsent: (choice: "granted" | "denied") => {
      harness.choices.push(choice)
      controller.setChoice(choice)
    },
  }
})

/** The banner on a page, once the router drew the page. */
async function renderPage() {
  renderInRouter(
    <>
      <span>page</span>
      <ConsentBanner />
    </>,
  )
  await screen.findByText("page")
}

function answer(consentRequired: boolean, choice: "granted" | "denied" | null) {
  act(() => {
    browserAnalytics.setChoice(choice)
    browserAnalytics.setConfig({ consentRequired, connection: CONNECTION })
  })
}

beforeEach(() => {
  harness.choices.length = 0
})

afterEach(() => {
  cleanup()
  // Back to "nothing known", as on a new page.
  act(() => browserAnalytics.update({ consentRequired: null, choice: null, connection: null }))
})

describe("consent banner", () => {
  test("renders nothing before the config answer and the stored choice are known", async () => {
    await renderPage()
    expect(screen.queryByRole("region", { name: "Analytics consent" })).toBeNull()
  })

  test("shows in the EEA and the UK before a choice, with Accept and Reject of the same size", async () => {
    await renderPage()
    answer(true, null)
    const banner = await screen.findByRole("region", { name: "Analytics consent" })
    const accept = screen.getByRole("button", { name: "Accept" })
    const reject = screen.getByRole("button", { name: "Reject" })
    expect(accept.className).toBe(reject.className)
    expect(banner.querySelector('a[href="/legal/privacy#cookies"]')).not.toBeNull()

    fireEvent.click(accept)
    expect(harness.choices).toEqual(["granted"])
    expect(screen.queryByRole("region", { name: "Analytics consent" })).toBeNull()
  })

  test("never shows where needsConsentPrompt is false: outside the EEA, or after a choice", async () => {
    await renderPage()
    answer(false, null)
    expect(screen.queryByRole("region", { name: "Analytics consent" })).toBeNull()
    answer(true, "denied")
    expect(screen.queryByRole("region", { name: "Analytics consent" })).toBeNull()
  })
})
