import { describe, expect, it } from "vitest";
import {
  browserAnalyticsMode,
  isConsentRequired,
  needsConsentPrompt,
  scrubAnalyticsProperties,
  scrubAnalyticsUrl,
  type BrowserAnalyticsState,
} from "../src/browser";

describe("isConsentRequired", () => {
  it.each(["DE", "fr", "IE", "NO", "IS", "LI", "GB"])("requires consent in %s", (country) => {
    expect(isConsentRequired(country)).toBe(true);
  });

  it.each(["US", "CA", "DZ", "IN", "CH", "BR"])("does not require consent in %s", (country) => {
    expect(isConsentRequired(country)).toBe(false);
  });

  it.each([null, undefined, "", "XX", "T1", "USA", "1A"])("treats %s as unknown, so consent is required", (country) => {
    expect(isConsentRequired(country)).toBe(true);
  });
});

describe("browserAnalyticsMode", () => {
  const state = (overrides: Partial<BrowserAnalyticsState>): BrowserAnalyticsState => ({
    consentRequired: null,
    choice: null,
    accountOptedOut: false,
    ...overrides,
  });

  it("runs in full outside the consent region by default", () => {
    expect(browserAnalyticsMode(state({ consentRequired: false }))).toBe("full");
    expect(needsConsentPrompt(state({ consentRequired: false }))).toBe(false);
  });

  it("stays anonymous in the consent region until the visitor accepts", () => {
    expect(browserAnalyticsMode(state({ consentRequired: true }))).toBe("anonymous");
    expect(needsConsentPrompt(state({ consentRequired: true }))).toBe(true);
    expect(browserAnalyticsMode(state({ consentRequired: true, choice: "granted" }))).toBe("full");
  });

  it("stays anonymous while the region is unknown", () => {
    expect(browserAnalyticsMode(state({}))).toBe("anonymous");
    expect(needsConsentPrompt(state({}))).toBe(false);
  });

  it("sends nothing after a refusal or an account opt-out", () => {
    expect(browserAnalyticsMode(state({ consentRequired: false, choice: "denied" }))).toBe("off");
    expect(browserAnalyticsMode(state({ consentRequired: true, choice: "granted", accountOptedOut: true }))).toBe("off");
    expect(needsConsentPrompt(state({ consentRequired: true, accountOptedOut: true }))).toBe(false);
  });
});

describe("scrubAnalyticsUrl", () => {
  it.each([
    ["https://doxa.so/reset-password?token=abc123#top", "https://doxa.so/reset-password"],
    ["https://doxa.so/email/unsubscribe?token=abc&kind=digest", "https://doxa.so/email/unsubscribe"],
    ["https://doxa.so/invite/inv_secret", "https://doxa.so/invite/:token"],
    ["https://doxa.so/invite/inv_secret/accept", "https://doxa.so/invite/:token/accept"],
    ["https://doxa.so/approve/req_123", "https://doxa.so/approve/:requestId"],
    ["https://doxa.so/oauth/consent?client_id=x&code=y", "https://doxa.so/oauth/consent"],
    ["https://doxa.so/?utm_source=x&utm_campaign=launch&ref=y", "https://doxa.so/?utm_source=x&utm_campaign=launch"],
    ["https://user:pass@example.com/a?b=c", "https://example.com/a"],
    ["/invite/inv_secret?x=1", "/invite/:token"],
    ["/dashboard/projects/123/content", "/dashboard/projects/123/content"],
  ])("scrubs %s", (input, expected) => {
    expect(scrubAnalyticsUrl(input)).toBe(expected);
  });

  it("returns an empty string for a value that is not a URL", () => {
    expect(scrubAnalyticsUrl("http://[bad")).toBe("");
  });
});

describe("scrubAnalyticsProperties", () => {
  it("scrubs every URL-like property and removes page titles", () => {
    expect(
      scrubAnalyticsProperties({
        $current_url: "https://doxa.so/reset-password?token=abc",
        $initial_referrer: "https://mail.example.com/inbox?id=42",
        $pathname: "/invite/inv_secret",
        title: "Billing roadmap · Acme docs",
        $browser: "Chrome",
        count: 3,
      }),
    ).toEqual({
      $current_url: "https://doxa.so/reset-password",
      $initial_referrer: "https://mail.example.com/inbox",
      $pathname: "/invite/:token",
      $browser: "Chrome",
      count: 3,
    });
  });
});
