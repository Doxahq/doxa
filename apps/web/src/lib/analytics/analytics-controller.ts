import {
  browserAnalyticsMode,
  needsConsentPrompt,
  type AnalyticsConsentChoice,
  type BrowserAnalyticsMode,
} from "@doxahq/analytics/browser"
import type { AnalyticsProperties } from "@doxahq/analytics"
import type { PostHogConfig } from "posthog-js"

import type { PostHogConnection } from "~/lib/analytics/analytics-config"
import { postHogInitOptions, postHogModeOptions } from "~/lib/analytics/posthog-options"

/** The part of posthog-js that Doxa uses. Tests pass a fake. */
export interface AnalyticsSdk {
  init(token: string, config: Partial<PostHogConfig>): unknown
  set_config(config: Partial<PostHogConfig>): void
  opt_in_capturing(options?: { captureEventName?: false }): void
  opt_out_capturing(): void
  has_opted_out_capturing(): boolean
  identify(distinctId: string, userPropertiesToSet?: Record<string, string>): void
  reset(): void
  capture(eventName: string, properties?: Record<string, string | number | boolean>): unknown
}

export interface AnalyticsPerson {
  readonly id: string
  readonly email: string | null
}

/** What the controller knows. Each field is null until its answer arrives. */
export interface AnalyticsSnapshot {
  /** Null until `/api/analytics-config` answers, and also when analytics is off on the server. */
  readonly connection: PostHogConnection | null
  /** True once the config route answered (with or without a connection). */
  readonly configLoaded: boolean
  readonly consentRequired: boolean | null
  /** Null until the browser store is read, and when the visitor has not chosen. */
  readonly choice: AnalyticsConsentChoice | null
  readonly choiceLoaded: boolean
  /** Null while a signed-in person's privacy settings load. */
  readonly accountOptedOut: boolean | null
  readonly person: AnalyticsPerson | null
}

export type AnalyticsSnapshotPatch = Partial<Omit<AnalyticsSnapshot, "configLoaded" | "choiceLoaded">>

export interface AnalyticsControllerOptions {
  /** Loads posthog-js. It runs once, when the first mode that sends anything is known. */
  readonly loadSdk: () => Promise<AnalyticsSdk>
  /** Hostnames that get PostHog's tracing headers, such as the API host. */
  readonly tracingHosts: readonly string[]
  /** False on the server: nothing loads and nothing is sent. */
  readonly isBrowser?: boolean
}

/** Browser events wait here while posthog-js loads. A short list: a page that never loads it drops them. */
const MAX_PENDING_EVENTS = 20

const INITIAL_SNAPSHOT: AnalyticsSnapshot = {
  connection: null,
  configLoaded: false,
  consentRequired: null,
  choice: null,
  choiceLoaded: false,
  accountOptedOut: false,
  person: null,
}

/**
 * True when the consent banner must show: every answer is in, analytics is
 * on for this site, and none of the answers decides already. Before that,
 * the banner renders nothing, so it never flashes or shifts the page.
 */
export function shouldShowConsentPrompt(snapshot: AnalyticsSnapshot): boolean {
  const { connection, configLoaded, choiceLoaded, consentRequired, choice, accountOptedOut } = snapshot
  if (!configLoaded || !choiceLoaded || !connection || accountOptedOut === null) return false
  return needsConsentPrompt({ consentRequired, choice, accountOptedOut })
}

/** The Privacy choices switch: on when analytics runs, or would run once it loads, with every cookie it needs. */
export function analyticsSwitchOn(snapshot: AnalyticsSnapshot): boolean {
  if (snapshot.accountOptedOut === true || snapshot.choice === "denied") return false
  return snapshot.choice === "granted" || snapshot.consentRequired === false
}

/**
 * Runs posthog-js for the whole page: it starts it once, in the mode that
 * the region, the visitor's choice and the account allow, and moves it
 * between `anonymous`, `full` and `off` without a reload.
 */
export class AnalyticsController {
  private snapshot: AnalyticsSnapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private sdk: AnalyticsSdk | null = null
  private loading: Promise<void> | null = null
  /** The mode that posthog-js runs in now; null before it starts. */
  private appliedMode: BrowserAnalyticsMode | null = null
  private identifiedAs: string | null = null
  private pendingEvents: { name: string; properties: AnalyticsProperties }[] = []

  constructor(private readonly options: AnalyticsControllerOptions) {}

  getSnapshot = (): AnalyticsSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The config route answered. */
  setConfig(config: { consentRequired: boolean; connection: PostHogConnection | null }): void {
    this.patch({ ...config, configLoaded: true })
  }

  /** The visitor's stored or new choice in this browser. */
  setChoice(choice: AnalyticsConsentChoice | null): void {
    this.patch({ choice, choiceLoaded: true })
  }

  update(patch: AnalyticsSnapshotPatch): void {
    this.patch(patch)
  }

  /** The mode that the current answers allow, or null while one that decides is missing. */
  desiredMode(): BrowserAnalyticsMode | null {
    const { connection, configLoaded, consentRequired, choiceLoaded, choice, accountOptedOut } = this.snapshot
    if (!configLoaded || !choiceLoaded) return null
    if (!connection) return "off"
    // A signed-in person whose settings still load: keep what runs, and never start before the answer.
    if (accountOptedOut === null) return this.appliedMode
    return browserAnalyticsMode({ consentRequired, choice, accountOptedOut })
  }

  /** The mode that posthog-js runs in now. */
  currentMode(): BrowserAnalyticsMode | null {
    return this.appliedMode
  }

  /** Sends a checked browser event. Only `full` mode sends events: `anonymous` sends page views only. */
  capture(name: string, properties: AnalyticsProperties): void {
    if (this.appliedMode === "full" && this.sdk) {
      this.sdk.capture(name, properties)
      return
    }
    // Wait for posthog-js only while it may still start in `full`.
    if (this.appliedMode === null && this.desiredMode() !== "off" && this.pendingEvents.length < MAX_PENDING_EVENTS) {
      this.pendingEvents.push({ name, properties })
    }
  }

  /** Sign-out: a new anonymous ID, so the next person in this browser is not linked to the last one. */
  signOut(): void {
    this.snapshot = { ...this.snapshot, person: null }
    this.emit()
    if (this.appliedMode === "full" && this.sdk) this.sdk.reset()
    this.identifiedAs = null
  }

  /** Waits for posthog-js to load, if it is loading. For tests. */
  async settled(): Promise<void> {
    await this.loading
  }

  private patch(patch: Partial<AnalyticsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
    this.sync()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private sync(): void {
    if (this.options.isBrowser === false) return
    const mode = this.desiredMode()
    if (mode === null) return
    if (!this.sdk) {
      if (mode === "off") {
        this.appliedMode = "off"
        this.pendingEvents = []
        return
      }
      this.start()
      return
    }
    if (mode !== this.appliedMode) this.applyMode(this.sdk, mode)
    this.syncPerson(this.sdk)
  }

  /** Loads posthog-js once, then applies the mode that is current when it arrives. */
  private start(): void {
    if (this.loading) return
    this.loading = this.options
      .loadSdk()
      .then((sdk) => {
        const mode = this.desiredMode()
        const connection = this.snapshot.connection
        if (!mode || mode === "off" || !connection) {
          // The answer changed while it loaded. Nothing started, so nothing to stop.
          this.loading = null
          this.appliedMode = mode
          this.pendingEvents = []
          return
        }
        sdk.init(connection.key, postHogInitOptions(connection, mode, this.options.tracingHosts))
        this.sdk = sdk
        this.optInIfFull(sdk, mode)
        this.appliedMode = mode
        this.syncPerson(sdk)
        this.flushPendingEvents(sdk)
      })
      .catch(() => {
        // An ad blocker or a network error: analytics stays off for this page.
        this.loading = null
        this.pendingEvents = []
      })
  }

  private applyMode(sdk: AnalyticsSdk, mode: BrowserAnalyticsMode): void {
    if (mode === "off") {
      sdk.set_config({ disable_session_recording: true })
      sdk.opt_out_capturing()
      this.identifiedAs = null
    } else {
      sdk.set_config(postHogModeOptions(mode))
      this.optInIfFull(sdk, mode)
    }
    this.appliedMode = mode
  }

  /**
   * A stored opt-out from an earlier visit loses to today's choice, but only
   * in `full` mode: opting in writes to browser storage, which `anonymous`
   * mode must never do. Do Not Track still wins inside posthog-js.
   */
  private optInIfFull(sdk: AnalyticsSdk, mode: BrowserAnalyticsMode): void {
    if (mode === "full" && sdk.has_opted_out_capturing()) sdk.opt_in_capturing({ captureEventName: false })
  }

  /** `identify` once per person, and only in `full` mode: anonymous mode has no person. */
  private syncPerson(sdk: AnalyticsSdk): void {
    const person = this.snapshot.person
    if (this.appliedMode !== "full" || !person || this.identifiedAs === person.id) return
    sdk.identify(person.id, person.email ? { email: person.email } : undefined)
    this.identifiedAs = person.id
  }

  private flushPendingEvents(sdk: AnalyticsSdk): void {
    const events = this.pendingEvents
    this.pendingEvents = []
    if (this.appliedMode !== "full") return
    for (const event of events) sdk.capture(event.name, event.properties)
  }
}
