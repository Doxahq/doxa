import { MemoryAnalyticsSink } from "@doxahq/analytics/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../../src/env";
import { AnalyticsOptOutCache } from "../../../src/services/analytics/opt-out-cache";
import { productAnalyticsOf } from "../../../src/services/analytics/product-analytics";
import { createProductAnalyticsBinding } from "../../../src/services/analytics/product-analytics-binding";
import { createWorkerProductAnalytics } from "../../../src/services/analytics/worker-product-analytics";
import { InMemoryPrivacySettings } from "../../support/in-memory-privacy-settings";

/** A request's env: the binding keys its client on the object. */
const requestEnv = (): Env => ({}) as Env;

function setup() {
  const sink = new MemoryAnalyticsSink();
  const store = new InMemoryPrivacySettings();
  const privacySettingsFor = vi.fn(() => store);
  const binding = createProductAnalyticsBinding({
    sink,
    optOuts: new AnalyticsOptOutCache(),
    privacySettingsFor,
    onDrop: () => {},
  });
  return { sink, store, privacySettingsFor, binding };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createProductAnalyticsBinding", () => {
  test("gives each env one client, and the client reads that env's settings", async () => {
    const { binding, privacySettingsFor } = setup();
    const first = requestEnv();
    const second = requestEnv();

    expect(binding.forEnv(first)).toBe(binding.forEnv(first));
    expect(binding.forEnv(first)).not.toBe(binding.forEnv(second));

    binding.forEnv(second).capture({ name: "team_created", distinctId: "user-1", properties: {} });
    await binding.forEnv(second).flush();
    expect(privacySettingsFor).toHaveBeenCalledWith(second);
  });

  test("drops the events of a person who turned analytics off", async () => {
    const { binding, sink, store } = setup();
    await store.setProductAnalytics("user-2", false, new Date());
    const analytics = binding.forEnv(requestEnv());

    analytics.capture({ name: "team_created", distinctId: "user-1", properties: {} });
    analytics.capture({ name: "team_created", distinctId: "user-2", properties: {} });
    await analytics.flush();

    expect(sink.recordsOf("event").map((record) => record.distinctId)).toEqual(["user-1"]);
  });

  test("a change in this process applies to the next record without a database read", async () => {
    const { binding, sink, store } = setup();
    const analytics = binding.forEnv(requestEnv());
    analytics.capture({ name: "team_created", distinctId: "user-1", properties: {} });
    await analytics.flush();

    binding.optOutChanged?.("user-1", true);
    analytics.capture({ name: "team_created", distinctId: "user-1", properties: {} });
    await analytics.flush();

    expect(sink.eventNames()).toEqual(["team_created"]);
    expect(store.reads).toBe(1);
  });

  test("productAnalyticsOf uses the binding of the env", async () => {
    const { binding, sink } = setup();
    const env = { ...requestEnv(), PRODUCT_ANALYTICS: binding };

    productAnalyticsOf(env).capture({ name: "team_created", distinctId: "user-1", properties: {} });
    await productAnalyticsOf(env).flush();

    expect(sink.eventNames()).toEqual(["team_created"]);
  });
});

describe("createWorkerProductAnalytics", () => {
  test("is off without a filled key", async () => {
    for (const vars of [{}, { POSTHOG_KEY: "${OPS_POSTHOG_PROJECT_KEY}" }]) {
      const analytics = createWorkerProductAnalytics(vars, { optOuts: new AnalyticsOptOutCache() });
      expect(analytics.binding).toBeUndefined();
      await expect(analytics.flush()).resolves.toBeUndefined();
    }
  });

  test("sends every record of the request when the request flushes", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(init.body);
        return new Response("{}", { status: 200 });
      }),
    );
    const store = new InMemoryPrivacySettings();
    const analytics = createWorkerProductAnalytics(
      { POSTHOG_KEY: "phc_test" },
      { optOuts: new AnalyticsOptOutCache(), privacySettingsFor: () => store },
    );
    const env = { ...requestEnv(), ...(analytics.binding ? { PRODUCT_ANALYTICS: analytics.binding } : {}) };

    productAnalyticsOf(env).capture({ name: "team_created", distinctId: "user-1", properties: {} });
    await analytics.flush();

    expect(analytics.binding).toBeDefined();
    expect(store.reads).toBe(1);
    expect(sent.length).toBeGreaterThan(0);
  });
});
