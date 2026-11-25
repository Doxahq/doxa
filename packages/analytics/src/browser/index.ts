/**
 * Pure browser helpers: the consent rules and the URL scrubber. The web app
 * owns `posthog-js` and calls these.
 */
export {
  CONSENT_REQUIRED_COUNTRIES,
  browserAnalyticsMode,
  isConsentRequired,
  needsConsentPrompt,
  type AnalyticsConsentChoice,
  type BrowserAnalyticsMode,
  type BrowserAnalyticsState,
} from "./consent";
export { scrubAnalyticsProperties, scrubAnalyticsUrl } from "./url-scrubber";
