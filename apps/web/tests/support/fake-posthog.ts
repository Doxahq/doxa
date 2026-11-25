import type { PostHogConfig } from "posthog-js"

import type { AnalyticsSdk } from "~/lib/analytics/analytics-controller"

export type FakePostHogCall =
  | { method: "init"; token: string; config: Partial<PostHogConfig> }
  | { method: "set_config"; config: Partial<PostHogConfig> }
  | { method: "opt_in_capturing" | "opt_out_capturing" | "reset" }
  | { method: "identify"; distinctId: string; properties: Record<string, string> | undefined }
  | { method: "capture"; eventName: string; properties: Record<string, string | number | boolean> | undefined }

/** A posthog-js stand-in that records each call, with posthog-js's opt-out state. */
export class FakePostHog implements AnalyticsSdk {
  readonly calls: FakePostHogCall[] = []
  optedOut: boolean

  constructor(options: { optedOut?: boolean } = {}) {
    this.optedOut = options.optedOut ?? false
  }

  init(token: string, config: Partial<PostHogConfig>): void {
    this.calls.push({ method: "init", token, config })
  }
  set_config(config: Partial<PostHogConfig>): void {
    this.calls.push({ method: "set_config", config })
  }
  opt_in_capturing(): void {
    this.optedOut = false
    this.calls.push({ method: "opt_in_capturing" })
  }
  opt_out_capturing(): void {
    this.optedOut = true
    this.calls.push({ method: "opt_out_capturing" })
  }
  has_opted_out_capturing(): boolean {
    return this.optedOut
  }
  identify(distinctId: string, properties?: Record<string, string>): void {
    this.calls.push({ method: "identify", distinctId, properties })
  }
  reset(): void {
    this.calls.push({ method: "reset" })
  }
  capture(eventName: string, properties?: Record<string, string | number | boolean>): void {
    this.calls.push({ method: "capture", eventName, properties })
  }

  methods(): string[] {
    return this.calls.map((call) => call.method)
  }
}
