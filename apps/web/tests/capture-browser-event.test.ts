import type { AnalyticsProperties } from "@doxahq/analytics"
import { describe, expect, test } from "vitest"

import { captureBrowserEvent, type BrowserEventSink } from "~/lib/analytics/capture-browser-event"

function recordingSink() {
  const events: { name: string; properties: AnalyticsProperties }[] = []
  const sink: BrowserEventSink = { capture: (name, properties) => events.push({ name, properties }) }
  return { sink, events }
}

describe("captureBrowserEvent", () => {
  test("sends a valid event with only the catalog's properties", () => {
    const { sink, events } = recordingSink()
    expect(captureBrowserEvent("cta_clicked", { location: "pricing_plans", cta: "upgrade", plan: "pro" }, sink)).toBe(true)
    expect(captureBrowserEvent("upgrade_clicked", { location: "pro_trial_dialog", interval: "year" }, sink)).toBe(true)
    expect(events).toEqual([
      { name: "cta_clicked", properties: { location: "pricing_plans", cta: "upgrade", plan: "pro" } },
      { name: "upgrade_clicked", properties: { location: "pro_trial_dialog", interval: "year" } },
    ])
  })

  test("drops free text, unknown plans and unknown methods: nothing reaches the sink", () => {
    const { sink, events } = recordingSink()
    expect(captureBrowserEvent("pro_trial_dialog_opened", { feature: "Acme's secret project" }, sink)).toBe(false)
    // @ts-expect-error -- the type forbids an unknown plan, and the runtime check must too.
    expect(captureBrowserEvent("cta_clicked", { location: "nav", cta: "get_started", plan: "gold" }, sink)).toBe(false)
    // @ts-expect-error -- the same for an unknown sign-up method.
    expect(captureBrowserEvent("signup_form_submitted", { method: "password" }, sink)).toBe(false)
    expect(events).toEqual([])
  })
})
