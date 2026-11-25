import { DAY_MS } from "@doxahq/billing";
import { describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../../src/http/app";
import { billingLifecycleAnalytics } from "../../../src/services/billing/billing-analytics";
import { createBillingHarness } from "../../support/billing-harness";
import { recordingProductAnalytics } from "../../support/recording-product-analytics";

const session = vi.hoisted(() => ({ userId: "user-1" }));
vi.mock("../../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(session.userId),
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { createBillingRoutes } = await import("../../../src/routes/billing");

const OWNER = "user-1";

function setup() {
  const recording = recordingProductAnalytics();
  const owners = new Map<string, string>();
  const harness = createBillingHarness({
    lifecycle: () =>
      billingLifecycleAnalytics({
        analytics: () => recording.analytics,
        ownerUserId: async (accountId) => owners.get(accountId) ?? null,
      }),
  });
  const app = createApiRouter();
  app.route("/billing", createBillingRoutes(() => harness.services()));
  const checkout = (accountId: string, offer: string) =>
    app.request(`https://api.doxa.so/billing/accounts/${accountId}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer }),
    });
  return { recording, owners, harness, checkout };
}

describe("billing lifecycle analytics", () => {
  test("a Checkout counts for the user who opened it, and stores the owner on the provider customer", async () => {
    const { recording, harness, checkout } = setup();
    const account = await harness.billing.accounts.accountForOwner("user", OWNER);

    expect((await checkout(account.id, "pro_yearly_founder_v2")).status).toBe(200);

    expect(await recording.events()).toEqual([
      {
        kind: "event",
        event: "checkout_started",
        distinctId: OWNER,
        properties: { plan_key: "pro_yearly_founder_v2", interval: "year", trial: true, founder: true },
        groups: { account: account.id },
      },
    ]);
    const customerId = (await harness.billing.store.getAccount(account.id))?.providerCustomerId ?? "";
    expect(harness.billing.provider.customerPersonDistinctId(customerId)).toBe(OWNER);
  });

  test("webhook facts count for the account owner, and a subscription change describes the account", async () => {
    const { recording, owners, harness, checkout } = setup();
    const account = await harness.billing.accounts.accountForOwner("user", OWNER);
    owners.set(account.id, OWNER);
    await checkout(account.id, "pro_monthly_v1");
    const checkoutId = (await harness.billing.store.getAccount(account.id))?.openCheckout?.checkoutId ?? "";
    harness.billing.provider.completeCheckout(checkoutId);
    for (const raw of harness.billing.provider.drainWebhooks()) await harness.payments.handleWebhook(raw);
    harness.billing.clock.advance(7 * DAY_MS);
    const customer = { provider: "memory" as const, customerId: (await harness.billing.store.getAccount(account.id))!.providerCustomerId! };
    harness.billing.provider.endTrial(customer);
    for (const raw of harness.billing.provider.drainWebhooks()) await harness.payments.handleWebhook(raw);

    await vi.waitFor(async () => expect((await recording.events()).map((event) => event.event)).toContain("trial_converted"));
    const events = await recording.events();
    // The owner lookup runs in the background, so webhook events may arrive in any order.
    expect(events.map((event) => event.event).sort()).toEqual(["checkout_completed", "checkout_started", "trial_converted", "trial_started"]);
    expect(events.every((event) => event.distinctId === OWNER && event.groups.account === account.id)).toBe(true);
    expect(events.find((event) => event.event === "trial_converted")?.properties).toEqual({ plan_key: "pro_monthly_v1", interval: "month", days_in_trial: 7 });
    expect(recording.sink.recordsOf("group").at(-1)).toEqual({
      kind: "group",
      groupType: "account",
      groupKey: account.id,
      properties: { plan: "pro", subscription_status: "active", interval: "month", founder: false },
    });
  });

  test("an event of an account without an owner is not sent", async () => {
    const recording = recordingProductAnalytics();
    const lookup = vi.fn(async () => null);
    billingLifecycleAnalytics({ analytics: () => recording.analytics, ownerUserId: lookup }).checkoutExpired?.({ accountId: "acct_1" });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith("acct_1"));
    expect(await recording.events()).toEqual([]);
  });

  test("a failed owner lookup never throws", async () => {
    const recording = recordingProductAnalytics();
    const events = billingLifecycleAnalytics({
      analytics: () => recording.analytics,
      ownerUserId: async () => {
        throw new Error("database is down");
      },
    });
    expect(() => events.invoiceSettled?.({ accountId: "acct_1", outcome: "paid", kind: "plan", amountCents: 12_900, attempt: 1 })).not.toThrow();
    expect(await recording.events()).toEqual([]);
  });
});
