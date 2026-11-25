/**
 * Countries where an analytics cookie needs consent before it is set: the
 * EEA (the EU, Iceland, Liechtenstein and Norway) and the United Kingdom.
 * The EU ePrivacy rules and the UK PECR require this prior consent.
 */
export const CONSENT_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set([
  // European Union
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // Rest of the EEA
  "IS", "LI", "NO",
  // United Kingdom
  "GB",
]);

/** Cloudflare's codes for an unknown country (`XX`) and for Tor (`T1`). */
const UNKNOWN_COUNTRIES: ReadonlySet<string> = new Set(["XX", "T1"]);

/**
 * True when a visitor from this country must consent first. An unknown or
 * missing country counts as one that needs consent, so the default is safe.
 */
export function isConsentRequired(country: string | null | undefined): boolean {
  const code = country?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(code) || UNKNOWN_COUNTRIES.has(code)) return true;
  return CONSENT_REQUIRED_COUNTRIES.has(code);
}

/** The visitor's own choice in this browser: in the consent banner or in Privacy choices. */
export type AnalyticsConsentChoice = "granted" | "denied";

/**
 * How the browser SDK runs:
 * - `off`: it sends nothing.
 * - `anonymous`: page views only, with no cookie or browser storage, while
 *   consent is still unknown.
 * - `full`: the PostHog cookie, the signed-in person, and masked session replay.
 */
export type BrowserAnalyticsMode = "off" | "anonymous" | "full";

export interface BrowserAnalyticsState {
  /** Null until the region check answers. */
  readonly consentRequired: boolean | null;
  /** Null before the visitor makes a choice in this browser. */
  readonly choice: AnalyticsConsentChoice | null;
  /** The signed-in person turned analytics off in Account settings. */
  readonly accountOptedOut: boolean;
}

export function browserAnalyticsMode(state: BrowserAnalyticsState): BrowserAnalyticsMode {
  if (state.accountOptedOut || state.choice === "denied") return "off";
  if (state.choice === "granted" || state.consentRequired === false) return "full";
  return "anonymous";
}

/** True when the consent banner must show: consent is required and the visitor has not chosen. */
export function needsConsentPrompt(state: BrowserAnalyticsState): boolean {
  return state.consentRequired === true && state.choice === null && !state.accountOptedOut;
}
