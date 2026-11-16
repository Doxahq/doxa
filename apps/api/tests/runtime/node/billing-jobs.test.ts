import { BillingConfigurationError, readBillingConfig } from "@doxahq/billing";
import { describe, expect, test, vi } from "vitest";
import { createBillingPaymentsRuntime, createNodeBillingPayments } from "../../../src/runtime/node/billing";
import { isFirstTickOfDay, isFirstTickOfHour } from "../../../src/runtime/node/billing-jobs";
import { billingConfigFor } from "../../../src/services/billing/config";
import { createBillingHarness } from "../../support/billing-harness";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

function jobsRun(logs: ReturnType<typeof createBillingHarness>["logs"]): string[] {
  return logs.filter((line) => line.event === "billing.sync" && "job" in line.fields).map((line) => String(line.fields.job));
}

describe("billing jobs in the 5-minute cron (billing spec 14.3)", () => {
  test("every tick: usage report retries and expired founder holds", async () => {
    const harness = createBillingHarness();
    await harness.payments.runScheduledJobs(Date.parse("2026-11-14T15:20:00Z"));
    expect(jobsRun(harness.logs)).toEqual(["payg.report", "offers.expired_holds"]);
  });

  test("first tick of an hour: catch-up, open subscription sync and grant expiry", async () => {
    const harness = createBillingHarness();
    await harness.payments.runScheduledJobs(Date.parse("2026-11-14T15:00:00Z"));
    expect(jobsRun(harness.logs)).toEqual(["payg.report", "offers.expired_holds", "billing.catch_up", "billing.sync_open", "credits.expire", "payg.sweep"]);
    expect(harness.logs.filter((line) => line.fields.outcome === "failed")).toEqual([]);
  });

  test("12:00 UTC, outside the nightly ECS pause: the reconcile", async () => {
    expect(isFirstTickOfDay(new Date("2026-11-14T12:03:00Z"))).toBe(true);
    expect(isFirstTickOfDay(new Date("2026-11-14T00:00:00Z"))).toBe(false);
    expect(isFirstTickOfHour(new Date("2026-11-14T12:05:00Z"))).toBe(false);
    const harness = createBillingHarness();
    await harness.payments.runScheduledJobs(Date.parse("2026-11-14T12:00:00Z"));
    expect(jobsRun(harness.logs)).toEqual(expect.arrayContaining(["payg.reconcile", "payg.sweep"]));
  });

  test("the monthly sweep catches up hourly: a missed window is swept late, once", async () => {
    const harness = createBillingHarness();
    const { billing } = harness;
    const account = await harness.core.accounts.accountForOwner("user", "payer");
    const link = await harness.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    await billing.deliverWebhooks();
    billing.provider.endTrial({ provider: "memory", customerId: (await harness.core.store.getAccount(account.id))!.providerCustomerId! });
    await billing.deliverWebhooks();
    const sweepLine = () => harness.logs.filter((line) => line.fields.job === "payg.sweep").at(-1)?.fields;
    // The jobs pick their schedule from the tick time; the sweep reads the billing clock.
    const hourTick = () => Date.parse("2026-11-14T15:00:00Z");
    await harness.payments.runScheduledJobs(hourTick());
    expect(sweepLine()).toMatchObject({ outcome: "ok", accounts: 1, ran: 1 });
    await harness.payments.runScheduledJobs(hourTick());
    expect(sweepLine()).toMatchObject({ outcome: "ok", ran: 0 });
    // The task was paused across the anchor: the next hourly tick, days later, still sweeps that window.
    billing.clock.advance(40 * 24 * 3_600_000);
    await harness.payments.runScheduledJobs(hourTick());
    expect(sweepLine()).toMatchObject({ outcome: "ok", ran: 1 });
    await harness.payments.runScheduledJobs(hourTick());
    expect(sweepLine()).toMatchObject({ outcome: "ok", ran: 0 });
  });

  test("one failing job is logged and the others still run", async () => {
    const harness = createBillingHarness();
    harness.billing.provider.failNext("listEventsSince");
    await harness.payments.runScheduledJobs(Date.parse("2026-11-14T15:00:00Z"));
    const failed = harness.logs.filter((line) => line.fields.outcome === "failed").map((line) => line.fields.job);
    expect(failed).toEqual(["billing.catch_up"]);
    expect(jobsRun(harness.logs)).toContain("credits.expire");
  });

  test("the none provider runs no job and builds nothing", async () => {
    const harness = createBillingHarness();
    let built = 0;
    const runtime = createBillingPaymentsRuntime({
      provider: { ...harness.billing.provider, name: "none" } as never,
      core: () => {
        built += 1;
        return harness.core;
      },
      log: () => undefined,
    });
    await runtime.runScheduledJobs(Date.parse("2026-11-14T12:00:00Z"));
    expect(built).toBe(0);
  });
});

describe("billing settings at start-up (billing spec 6.3)", () => {
  test("the defaults are provider none, enforcement off, plan self_hosted", () => {
    expect(billingConfigFor({ WEB_ORIGIN: "https://doxa.so" })).toMatchObject({
      provider: "none",
      enforcement: "off",
      defaultPlan: "self_hosted",
      returnBaseUrl: "https://doxa.so",
    });
  });

  test("a wrong value or a missing Stripe secret fails start-up", () => {
    expect(() => billingConfigFor({ BILLING_ENFORCEMENT: "maybe", WEB_ORIGIN: "https://doxa.so" })).toThrow(BillingConfigurationError);
    expect(() => billingConfigFor({ BILLING_PROVIDER: "stripe", WEB_ORIGIN: "https://doxa.so" })).toThrow(BillingConfigurationError);
    expect(() => billingConfigFor({ BILLING_RETURN_BASE_URL: "https://doxa.so/evil?x=1" })).toThrow(BillingConfigurationError);
  });

  test("the Node binding builds the provider once from the config", () => {
    const config = readBillingConfig({ BILLING_PROVIDER: "memory" }, { dashboardUrl: "https://doxa.test" });
    const binding = createNodeBillingPayments({ config, coreFor: () => createBillingHarness().core });
    expect(binding.forEnv({} as never).providerName).toBe("memory");
    const none = createNodeBillingPayments({ config: readBillingConfig({}, { dashboardUrl: "https://doxa.test" }) });
    expect(none.forEnv({} as never).providerName).toBe("none");
  });
});
