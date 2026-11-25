import type { AnalyticsConsentChoice } from "@doxahq/analytics/browser"

/** The visitor's analytics choice in this browser. The Privacy Policy lists this key. */
export const ANALYTICS_CONSENT_STORAGE_KEY = "doxa:analytics-consent"

export interface ConsentStore {
  /** Null before the visitor chooses, and when the browser blocks storage. */
  read(): AnalyticsConsentChoice | null
  write(choice: AnalyticsConsentChoice): void
}

/**
 * `window.localStorage`, or null on the server. Reading the property itself
 * throws in some browsers when site data is blocked.
 */
function browserLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

/** Every access is guarded: a blocked store reads as "no choice yet" and a write is dropped. */
export function createConsentStore(storage: () => Storage | null = browserLocalStorage): ConsentStore {
  return {
    read() {
      try {
        return parseConsentChoice(storage()?.getItem(ANALYTICS_CONSENT_STORAGE_KEY) ?? null)
      } catch {
        return null
      }
    },
    write(choice) {
      try {
        storage()?.setItem(ANALYTICS_CONSENT_STORAGE_KEY, choice)
      } catch {
        // Private mode or a full store: the choice lasts until the page closes.
      }
    },
  }
}

/** A stored value, or null for anything that this code did not write. */
export function parseConsentChoice(value: string | null): AnalyticsConsentChoice | null {
  return value === "granted" || value === "denied" ? value : null
}
