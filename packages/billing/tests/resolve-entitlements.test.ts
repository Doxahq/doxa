import { describe, expect, it } from "vitest";

import { DAY_MS, DOXA_CATALOG, PLAN_KEYS, SUBSCRIPTION_STATUSES, UNLIMITED, resolveEntitlements, type OverrideRecord, type SubscriptionStatus } from "../src/index";
import { TEST_NOW, subscriptionFixture } from "../src/testing";

const now = TEST_NOW;
const sub = (status: SubscriptionStatus, extra: Partial<Parameters<typeof subscriptionFixture>[0]> = {}) =>
  subscriptionFixture({ accountId: "acct_1", status, ...extra });

let overrideId = 0;
function override(key: string, value: OverrideRecord["value"], window: { startsAt?: Date | null; expiresAt?: Date | null } = {}): OverrideRecord {
  overrideId += 1;
  return {
    id: `ovr_${overrideId}`,
    accountId: "acct_1",
    key,
    value,
    reason: "test",
    startsAt: window.startsAt ?? null,
    expiresAt: window.expiresAt ?? null,
    createdBy: "test",
    createdAt: new Date(now.getTime() + overrideId),
  };
}

const resolve = (subscription: ReturnType<typeof sub> | null, overrides: OverrideRecord[] = [], at = now, defaultPlan: "free" | "self_hosted" = "free") =>
  resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan, subscription, overrides, now: at });

describe("resolveEntitlements", () => {
  const expected: Record<SubscriptionStatus, "pro" | "free"> = {
    trialing: "pro",
    active: "pro",
    past_due: "pro",
    incomplete: "free",
    incomplete_expired: "free",
    canceled: "free",
    unpaid: "free",
    paused: "free",
  };

  it.each(SUBSCRIPTION_STATUSES)("maps a Pro subscription in %s to its plan or the default", (status) => {
    const result = resolve(sub(status, status === "past_due" ? { pastDueSince: now } : {}));
    expect(result.plan).toBe(expected[status]);
    expect(result.source).toBe(expected[status] === "pro" ? "subscription" : "default");
  });

  it.each(PLAN_KEYS)("gives the %s plan from a plan override over any subscription", (plan) => {
    for (const status of SUBSCRIPTION_STATUSES) {
      const result = resolve(sub(status), [override("plan", plan)]);
      expect(result.plan).toBe(plan);
      expect(result.source).toBe("override");
      expect(result.limits).toMatchObject(
        Object.fromEntries(Object.entries(DOXA_CATALOG.plans[plan].limits)),
      );
    }
  });

  it("uses the default plan without a subscription", () => {
    expect(resolve(null).plan).toBe("free");
    expect(resolve(null, [], now, "self_hosted")).toMatchObject({ plan: "self_hosted", enforceCredits: false });
  });

  it("applies single-key overrides on top of the plan, and ignores expired or future ones", () => {
    const past = new Date(now.getTime() - DAY_MS);
    const future = new Date(now.getTime() + DAY_MS);
    const result = resolve(sub("active"), [
      override("site.custom_domains", 10),
      override("docs.branches_per_site", 7, { expiresAt: now }),
      override("team.seats", 3, { startsAt: future }),
      override("ai.credits_monthly", 20_000, { startsAt: past, expiresAt: future }),
      override("agents.approval_rules", true),
    ]);
    expect(result.limits["site.custom_domains"]).toBe(10);
    expect(result.limits["docs.branches_per_site"]).toBe(UNLIMITED);
    expect(result.limits["team.seats"]).toBe(UNLIMITED);
    expect(result.limits["ai.credits_monthly"]).toBe(20_000);
    expect(result.features["agents.approval_rules"]).toBe(true);
  });

  it("ignores an override with a value of the wrong type", () => {
    const bad = override("site.custom_domains", "ten");
    const result = resolve(sub("active"), [bad, override("plan", "platinum")]);
    expect(result.limits["site.custom_domains"]).toBe(4);
    expect(result.plan).toBe("pro");
    expect(result.ignoredOverrides).toContain(bad.id);
  });

  it("lets an expired plan override fall back to the subscription", () => {
    const result = resolve(sub("active"), [override("plan", "enterprise", { expiresAt: new Date(now.getTime() - 1) })]);
    expect(result.plan).toBe("pro");
  });

  it("keeps full access for the 7-day grace period, then pauses AI (D5)", () => {
    const pastDueSince = new Date(now.getTime() - 7 * DAY_MS);
    const subscription = sub("past_due", { pastDueSince });
    const oneSecondBefore = resolve(subscription, [], new Date(now.getTime() - 1000));
    expect(oneSecondBefore.inGracePeriod).toBe(true);
    expect(oneSecondBefore.features["ai.doxa_agent"]).toBe(true);
    const oneSecondAfter = resolve(subscription, [], new Date(now.getTime() + 1000));
    expect(oneSecondAfter.inGracePeriod).toBe(false);
    expect(oneSecondAfter.plan).toBe("pro");
    expect(oneSecondAfter.features["ai.doxa_agent"]).toBe(false);
    expect(oneSecondAfter.featureReasons["ai.doxa_agent"]).toBe("past_due");
    expect(oneSecondAfter.features["site.remove_powered_by"]).toBe(true);
  });

  it("gives a past-due account the Free export window after the grace period, keeps the rest of the plan", () => {
    const pastDueSince = new Date(now.getTime() - 7 * DAY_MS);
    const subscription = sub("past_due", { pastDueSince });
    const inGrace = resolve(subscription, [], new Date(now.getTime() - 1000));
    expect(inGrace.limits["docs.export_window_hours"]).toBe(1);
    const after = resolve(subscription, [], new Date(now.getTime() + 1000));
    expect(after.limits["docs.export_window_hours"]).toBe(24);
    expect(after.limits["site.custom_domains"]).toBe(DOXA_CATALOG.plans.pro.limits["site.custom_domains"]);
    // An override still wins.
    const overridden = resolve(subscription, [override("docs.export_window_hours", 1)], new Date(now.getTime() + 1000));
    expect(overridden.limits["docs.export_window_hours"]).toBe(1);
  });

  it("denies docs chat with coming_soon on every plan while the action is planned", () => {
    for (const plan of PLAN_KEYS) {
      const result = resolve(null, [override("plan", plan), override("ai.docs_chat", true)]);
      expect(result.features["ai.docs_chat"]).toBe(false);
      expect(result.featureReasons["ai.docs_chat"]).toBe("coming_soon");
    }
  });

  it("uses the provider plan for a price outside the catalog (Enterprise)", () => {
    const result = resolve(sub("active", { priceKey: "enterprise_contract_acme", planKey: "enterprise" }));
    expect(result.plan).toBe("enterprise");
  });
});
