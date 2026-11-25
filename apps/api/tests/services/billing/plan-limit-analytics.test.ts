import { CreditsExhaustedError, PlanLimitError } from "@doxahq/billing";
import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../../src/env";
import { deniedLimitOf, planLimitHitEvent, reportPlanLimitHit } from "../../../src/services/billing/plan-limit-analytics";
import { recordingProductAnalytics } from "../../support/recording-product-analytics";

const projectLimit = new PlanLimitError({ key: "account.projects", limit: 1, used: 1, accountId: "acct_1", plan: "free" });
const credits = new CreditsExhaustedError({ accountId: "acct_1", available: 0, needed: 50, reason: "trial_credits", resetsAt: null });

describe("plan_limit_hit", () => {
  test("names the limit key, or the credit reason", () => {
    expect(deniedLimitOf(projectLimit)).toBe("account.projects");
    expect(deniedLimitOf(credits)).toBe("credits.trial_credits");
  });

  test("counts for the refused user, in the account and the project", async () => {
    const recording = recordingProductAnalytics();
    recording.analytics.capture(planLimitHitEvent({ userId: "user-1", denial: credits, projectId: "project-1" }, "pro"));
    expect(await recording.events()).toEqual([
      {
        kind: "event",
        event: "plan_limit_hit",
        distinctId: "user-1",
        properties: { limit: "credits.trial_credits", plan: "pro" },
        groups: { account: "acct_1", project: "project-1" },
      },
    ]);
  });

  test("takes the plan from the error, and the default plan while enforcement is not on", async () => {
    const recording = recordingProductAnalytics();
    const env = { PRODUCT_ANALYTICS: recording.binding, BILLING_PROVIDER: "memory", BILLING_ENFORCEMENT: "off" } as Partial<Env> as Env;

    reportPlanLimitHit(env, "user-1", projectLimit);
    reportPlanLimitHit(env, "user-2", new PlanLimitError({ key: "site.custom_domains", limit: 1, used: 1 }), "project-1");

    await vi.waitFor(async () => expect(await recording.events()).toHaveLength(2));
    expect((await recording.events()).map(({ distinctId, properties }) => ({ distinctId, properties }))).toEqual([
      { distinctId: "user-1", properties: { limit: "account.projects", plan: "free" } },
      { distinctId: "user-2", properties: { limit: "site.custom_domains", plan: "free" } },
    ]);
  });

  test("ignores any other error", async () => {
    const recording = recordingProductAnalytics();
    reportPlanLimitHit({ PRODUCT_ANALYTICS: recording.binding } as Partial<Env> as Env, "user-1", new Error("boom"));
    expect(await recording.events()).toEqual([]);
  });
});
