import { describe, expect, it } from "vitest";
import {
  NOOP_PRODUCT_ANALYTICS,
  PRODUCT_EVENTS,
  isProductEventName,
  parseProductEventProperties,
  type ProductEventName,
} from "../src";

describe("PRODUCT_EVENTS", () => {
  it("names every event object_action in snake case", () => {
    for (const name of Object.keys(PRODUCT_EVENTS)) {
      expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/);
    }
  });

  it("drops a property that the catalog does not list", () => {
    const result = parseProductEventProperties("project_created", {
      source: "repo",
      via: "web",
      // A caller that adds content by mistake: it must never reach a provider.
      ...{ repository: "acme/secret-plans" },
    });
    expect(result).toEqual({ ok: true, properties: { source: "repo", via: "web" } });
  });

  it("names the failed paths and never the values", () => {
    const result = parseProductEventProperties("generation_finished", {
      trigger: "manual",
      outcome: "failed",
      duration_s: 12,
      error_code: "Could not read src/billing/secret.ts",
    });
    expect(result).toEqual({ ok: false, paths: ["error_code"] });
  });

  it.each([
    ["an email", "person@example.com"],
    ["a path", "src/index.ts"],
    ["a sentence", "Model timed out"],
    ["upper case", "TIMEOUT"],
  ])("refuses %s as a code", (_label, value) => {
    const result = parseProductEventProperties("plan_limit_hit", { limit: value, plan: "free" });
    expect(result.ok).toBe(false);
  });

  it("refuses an unknown event name at run time", () => {
    expect(isProductEventName("checkout_started")).toBe(true);
    expect(isProductEventName("toString")).toBe(false);
    const unknownName: string = "secret_event";
    expect(isProductEventName(unknownName)).toBe(false);
  });

  it("keeps optional properties out when they are not given", () => {
    const result = parseProductEventProperties("cta_clicked", { location: "home_hero", cta: "get_started" });
    expect(result).toEqual({ ok: true, properties: { location: "home_hero", cta: "get_started" } });
  });

  it("splits events by source", () => {
    const browserEvents = Object.keys(PRODUCT_EVENTS)
      .filter(isProductEventName)
      .filter((name: ProductEventName) => PRODUCT_EVENTS[name].source === "browser");
    expect(browserEvents.sort()).toEqual([
      "cta_clicked",
      "pro_trial_dialog_opened",
      "signup_form_submitted",
      "upgrade_clicked",
    ]);
  });
});

describe("NOOP_PRODUCT_ANALYTICS", () => {
  it("never runs a captureWhenReady read", async () => {
    let reads = 0;
    NOOP_PRODUCT_ANALYTICS.captureWhenReady(async () => {
      reads += 1;
      return [];
    });
    await NOOP_PRODUCT_ANALYTICS.flush();
    expect(reads).toBe(0);
  });
});
