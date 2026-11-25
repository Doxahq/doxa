import { describe, expect, it } from "vitest";

import { DAY_MS, DOXA_CATALOG, type ProviderCustomerRef } from "../src/index";
import { subscriptionChanges } from "../src/lifecycle-events";
import { BillingPayments } from "../src/payments/service";
import { createTestBilling, subscriptionFixture, type RecordedLifecycleEvent, type TestBilling } from "../src/testing";
import { paidProAccount, runJob, useAllowance } from "./helpers/pro";

function methods(billing: TestBilling): RecordedLifecycleEvent["method"][] {
  return billing.lifecycle.map((call) => call.method);
}

function changeKinds(billing: TestBilling): string[] {
  return billing.lifecycle.flatMap((call) => (call.method === "subscriptionChanged" ? [call.event.kind] : []));
}

async function customerOf(billing: TestBilling, accountId: string): Promise<ProviderCustomerRef> {
  return { provider: "memory", customerId: (await billing.store.getAccount(accountId))!.providerCustomerId! };
}

describe("billing lifecycle events: Checkout", () => {
  it("reports a new Checkout with its price facts and the user who opened it", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u1");
    await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_yearly_founder_v2", requestId: "r1", actorUserId: "u1" });
    expect(billing.lifecycle).toEqual([
      {
        method: "checkoutStarted",
        event: { accountId: account.id, priceKey: "pro_yearly_founder_v2", interval: "year", trial: true, founder: true, actorUserId: "u1" },
      },
    ]);
  });

  it("does not report a reused Checkout again", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u1");
    await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r2" });
    expect(methods(billing)).toEqual(["checkoutStarted"]);
  });

  it("reports a completed Checkout once, with the price of the new subscription", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u1");
    const link = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    const webhooks = billing.provider.drainWebhooks();
    for (const raw of [...webhooks, ...webhooks]) await billing.webhooks.handle(raw);
    expect(billing.lifecycle.filter((call) => call.method === "checkoutCompleted")).toEqual([
      { method: "checkoutCompleted", event: { accountId: account.id, priceKey: "pro_monthly_v1", interval: "month" } },
    ]);
  });

  it("reports an expired Checkout for its account", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u1");
    const link = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    await billing.provider.expireCheckout(link.checkoutId);
    expect(await billing.deliverWebhooks()).toEqual([200]);
    expect(billing.lifecycle.at(-1)).toEqual({ method: "checkoutExpired", event: { accountId: account.id } });
  });
});

describe("billing lifecycle events: the subscription mirror", () => {
  it("reports the trial start once, and its conversion with the days in trial", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u1");
    const link = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    await billing.deliverWebhooks();
    await billing.payments.syncCheckout(link.checkoutId);
    billing.clock.advance(7 * DAY_MS);
    billing.provider.endTrial(await customerOf(billing, account.id));
    await billing.deliverWebhooks();

    expect(changeKinds(billing)).toEqual(["trial_started", "trial_converted"]);
    expect(billing.lifecycle.find((call) => call.method === "subscriptionChanged" && call.event.kind === "trial_converted")).toEqual({
      method: "subscriptionChanged",
      event: {
        kind: "trial_converted",
        daysInTrial: 7,
        subscription: { accountId: account.id, planKey: "pro", priceKey: "pro_monthly_v1", status: "active", interval: "month", founder: false },
      },
    });
  });

  it("reports past due when the first charge fails, then the cancel", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u1");
    const link = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    await billing.deliverWebhooks();
    const customer = await customerOf(billing, account.id);
    billing.provider.setCardFails(customer, true);
    billing.provider.endTrial(customer);
    await billing.deliverWebhooks();
    billing.provider.setSubscriptionStatus(customer, "canceled");
    await billing.deliverWebhooks();

    expect(changeKinds(billing)).toEqual(["trial_started", "past_due", "canceled"]);
    expect(billing.lifecycle.at(-1)).toMatchObject({ event: { kind: "canceled", wasTrial: false } });
  });

  it("reports an interval switch", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    await billing.payments.switchPlanInterval({ accountId: account.id, interval: "year", requestId: "r2" });
    await billing.deliverWebhooks();
    expect(billing.lifecycle.at(-1)).toMatchObject({ method: "subscriptionChanged", event: { kind: "interval_changed", from: "month", to: "year" } });
  });

  it("finds each change from the mirror before and after", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const base = subscriptionFixture({ accountId: "a1", priceKey: "pro_monthly_v1", currentPeriodStart: new Date("2026-11-10T00:00:00Z") });
    const changes = (previous: typeof base | null, next: typeof base | null) =>
      subscriptionChanges({ catalog: DOXA_CATALOG, previous, next, now }).map((change) => change.kind);

    expect(changes(null, { ...base, status: "active" })).toEqual(["subscription_started"]);
    expect(changes({ ...base, status: "incomplete" }, { ...base, status: "active" })).toEqual(["subscription_started"]);
    expect(changes({ ...base, status: "trialing" }, { ...base, status: "canceled" })).toEqual(["canceled"]);
    expect(changes({ ...base, status: "active" }, { ...base, status: "active" })).toEqual([]);
    expect(changes({ ...base, status: "past_due" }, { ...base, status: "active" })).toEqual([]);
    expect(changes({ ...base, status: "active" }, null)).toEqual([]);
    // Enterprise prices are outside the catalog: nothing to report.
    expect(changes(null, { ...base, priceKey: "enterprise_custom", status: "active" })).toEqual([]);
    const [trial] = subscriptionChanges({ catalog: DOXA_CATALOG, previous: { ...base, status: "trialing" }, next: { ...base, status: "canceled" }, now });
    expect(trial).toMatchObject({ kind: "canceled", wasTrial: true });
  });
});

describe("billing lifecycle events: invoices", () => {
  it("reports a paid plan invoice with its amount and attempt, and skips a $0 one", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    billing.lifecycle.length = 0;
    billing.provider.emit({
      type: "customer.changed",
      providerType: "invoice.paid",
      customer,
      invoice: { invoiceId: "in_1", outcome: "paid", amountCents: 12_900, attempt: 1 },
    });
    billing.provider.emit({
      type: "customer.changed",
      providerType: "invoice.paid",
      customer,
      invoice: { invoiceId: "in_trial", outcome: "paid", amountCents: 0, attempt: 1 },
    });
    expect(await billing.deliverWebhooks()).toEqual([200, 200]);
    expect(billing.lifecycle).toEqual([
      { method: "invoiceSettled", event: { accountId: account.id, outcome: "paid", kind: "plan", amountCents: 12_900, attempt: 1 } },
    ]);
  });

  it("reports a failed plan invoice", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    billing.lifecycle.length = 0;
    billing.provider.emit({
      type: "customer.changed",
      providerType: "invoice.payment_failed",
      customer,
      invoice: { invoiceId: "in_2", outcome: "failed", amountCents: 12_900, attempt: 2 },
    });
    await billing.deliverWebhooks();
    expect(billing.lifecycle).toContainEqual({
      method: "invoiceSettled",
      event: { accountId: account.id, outcome: "failed", kind: "plan", amountCents: 12_900, attempt: 2 },
    });
  });

  it("reports a pay-as-you-go invoice once, although the paid event comes twice", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    await useAllowance(billing, account.id, "j1");
    await runJob(billing, account.id, "j2", 1.83);
    await billing.payments.reportPendingUsage();
    billing.lifecycle.length = 0;
    await billing.deliverWebhooks();
    const [invoice] = await billing.store.listPaygInvoices(account.id);
    billing.provider.emit({
      type: "usage_invoice.paid",
      providerType: "invoice.paid",
      invoice: { invoiceId: invoice!.providerInvoiceId, customer, credits: invoice!.credits, amountCents: invoice!.amountCents, reason: "threshold", hostedInvoiceUrl: null },
    });
    await billing.deliverWebhooks();
    const usage = billing.lifecycle.filter((call) => call.method === "invoiceSettled");
    expect(usage).toEqual([
      { method: "invoiceSettled", event: { accountId: account.id, outcome: "paid", kind: "usage", amountCents: invoice!.amountCents, attempt: null } },
    ]);
  });
});

describe("billing lifecycle events: a broken listener", () => {
  it("never changes the billing work", async () => {
    const billing = createTestBilling();
    const thrower = () => {
      throw new Error("analytics is down");
    };
    const payments = new BillingPayments({
      store: billing.store,
      catalog: billing.catalog,
      clock: billing.clock,
      provider: billing.provider,
      ledger: billing.ledger,
      offers: billing.offers,
      entitlements: billing.entitlements,
      defaultPlan: "free",
      returnBaseUrl: "https://doxa.test",
      lifecycle: { checkoutStarted: thrower, subscriptionChanged: thrower },
    });
    const account = await billing.accounts.accountForOwner("user", "u1");
    const link = await payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    expect(await payments.syncCheckout(link.checkoutId)).toMatchObject({ accountId: account.id, to: "pro" });
  });
});
