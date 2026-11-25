import { describe, expect, it } from "vitest";
import { POSTHOG_US_HOST, postHogSettingsFromEnv, readPostHogSettings } from "../src";

describe("readPostHogSettings", () => {
  it("turns analytics off without a key and names the variable", () => {
    const result = postHogSettingsFromEnv({ POSTHOG_KEY: "  " });
    expect(result.enabled).toBe(false);
    if (result.enabled) return;
    expect(result.reason).toBe("missing_key");
    expect(result.warning).toContain("POSTHOG_KEY variable required by PostHog is missing");
  });

  it("uses PostHog US Cloud by default", () => {
    expect(postHogSettingsFromEnv({ POSTHOG_KEY: "phc_test" })).toEqual({
      enabled: true,
      settings: { projectKey: "phc_test", host: POSTHOG_US_HOST },
    });
  });

  it("accepts a proxy host and drops a trailing slash", () => {
    const result = postHogSettingsFromEnv({ POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://relay.doxa.so/" });
    expect(result).toEqual({ enabled: true, settings: { projectKey: "phc_test", host: "https://relay.doxa.so" } });
  });

  it.each(["relay.doxa.so", "http://relay.doxa.so", "ftp://x"])("turns analytics off for the host %s", (host) => {
    const result = postHogSettingsFromEnv({ POSTHOG_KEY: "phc_test", POSTHOG_HOST: host });
    expect(result).toMatchObject({ enabled: false, reason: "invalid_host" });
  });

  it("treats unfilled ops placeholders as unset", () => {
    expect(postHogSettingsFromEnv({ POSTHOG_KEY: "${OPS_POSTHOG_PROJECT_KEY}" })).toMatchObject({ enabled: false, reason: "missing_key" });
    expect(
      postHogSettingsFromEnv({ POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://${OPS_POSTHOG_INGEST_HOSTNAME}" }),
    ).toEqual({ enabled: true, settings: { projectKey: "phc_test", host: POSTHOG_US_HOST } });
  });

  it("accepts plain http on a loopback host", () => {
    expect(postHogSettingsFromEnv({ POSTHOG_KEY: "phc_test", POSTHOG_HOST: "http://localhost:8010" }).enabled).toBe(true);
  });

  it("names the variables that the caller uses", () => {
    const result = readPostHogSettings({ key: undefined, host: undefined }, { key: "VITE_POSTHOG_KEY", host: "VITE_POSTHOG_HOST" });
    expect(result).toMatchObject({ enabled: false, warning: expect.stringContaining("VITE_POSTHOG_KEY") });
  });
});
