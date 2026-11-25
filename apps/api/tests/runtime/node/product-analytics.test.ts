import { MemoryAnalyticsSink } from "@doxahq/analytics/testing";
import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../../src/env";
import { AnalyticsOptOutCache } from "../../../src/services/analytics/opt-out-cache";
import { createNodeProductAnalytics } from "../../../src/runtime/node/product-analytics";

describe("createNodeProductAnalytics", () => {
  test("without a key, analytics is off and says so once outside production", async () => {
    const warn = vi.fn();
    const createSink = vi.fn(() => new MemoryAnalyticsSink());

    const analytics = createNodeProductAnalytics({ DOXA_RUNTIME_ENVIRONMENT: "development" }, { warn, createSink });

    expect(analytics.binding).toBeUndefined();
    expect(createSink).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("POSTHOG_KEY");
    await expect(analytics.close()).resolves.toBeUndefined();
  });

  test("stays silent in production, also with an unfilled placeholder", () => {
    const warn = vi.fn();
    for (const POSTHOG_KEY of [undefined, "${OPS_POSTHOG_PROJECT_KEY}"]) {
      const analytics = createNodeProductAnalytics(
        { DOXA_RUNTIME_ENVIRONMENT: "production", ...(POSTHOG_KEY ? { POSTHOG_KEY } : {}) },
        { warn },
      );
      expect(analytics.binding).toBeUndefined();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("builds one sink for the process, and close sends what is queued", async () => {
    const sink = new MemoryAnalyticsSink();
    const createSink = vi.fn(() => sink);
    const optOuts = new AnalyticsOptOutCache();
    optOuts.remember("user-1", false);

    const analytics = createNodeProductAnalytics({ POSTHOG_KEY: "phc_test" }, { createSink, optOuts });
    const binding = analytics.binding;
    if (!binding) throw new Error("expected analytics to be on");
    const first = {} as Env;
    const second = {} as Env;
    binding.forEnv(first).capture({ name: "team_created", distinctId: "user-1", properties: {} });
    binding.forEnv(second).capture({ name: "team_created", distinctId: "user-1", properties: {} });
    await Promise.all([binding.forEnv(first).flush(), binding.forEnv(second).flush()]);
    await analytics.close();

    expect(createSink).toHaveBeenCalledTimes(1);
    expect(createSink).toHaveBeenCalledWith({ projectKey: "phc_test", host: "https://us.i.posthog.com" });
    expect(sink.eventNames()).toEqual(["team_created", "team_created"]);
    expect(sink.isShutDown).toBe(true);
  });

  test("a failed shutdown never fails the origin's close", async () => {
    const sink = new MemoryAnalyticsSink();
    vi.spyOn(sink, "shutdown").mockRejectedValue(new Error("network down"));

    const analytics = createNodeProductAnalytics({ POSTHOG_KEY: "phc_test" }, { createSink: () => sink });

    await expect(analytics.close()).resolves.toBeUndefined();
  });
});
