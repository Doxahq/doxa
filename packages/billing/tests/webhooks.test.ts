import { describe, expect, it } from "vitest";

import { createTestBilling } from "../src/testing";

async function checkoutWebhooks(billing: ReturnType<typeof createTestBilling>) {
  const account = await billing.accounts.accountForOwner("user", "u");
  const link = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
  billing.provider.completeCheckout(link.checkoutId);
  return { account, link, webhooks: billing.provider.drainWebhooks() };
}

describe("billing webhooks", () => {
  it("answers 400 to a bad signature and stores nothing", async () => {
    const billing = createTestBilling();
    const { webhooks } = await checkoutWebhooks(billing);
    const raw = webhooks[0]!;
    const response = await billing.webhooks.handle({ ...raw, body: raw.body.replace("checkout", "checkouT") });
    expect(response).toEqual({ status: 400, body: { ok: false, error: "bad_signature" } });
    const missing = await billing.webhooks.handle({ body: raw.body, headers: {} });
    expect(missing.status).toBe(400);
    const event = JSON.parse(raw.body) as { id: string };
    expect(await billing.store.getProviderEvent("memory", event.id)).toBeNull();
  });

  it("refuses an old signature (5-minute tolerance)", async () => {
    const billing = createTestBilling();
    const { webhooks } = await checkoutWebhooks(billing);
    billing.clock.advance(6 * 60_000);
    expect((await billing.webhooks.handle(webhooks[0]!)).status).toBe(400);
  });

  it("answers a duplicate with 200 at once", async () => {
    const billing = createTestBilling();
    const { webhooks, account } = await checkoutWebhooks(billing);
    for (const raw of webhooks) expect((await billing.webhooks.handle(raw)).status).toBe(200);
    const again = await billing.webhooks.handle(webhooks[0]!);
    expect(again).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect((await billing.store.getAccount(account.id))?.planKey).toBe("pro");
  });

  it("gives the same state when events arrive out of order", async () => {
    const billing = createTestBilling();
    const { webhooks, account } = await checkoutWebhooks(billing);
    const customer = { provider: "memory" as const, customerId: (await billing.store.getAccount(account.id))!.providerCustomerId! };
    billing.provider.setCancelAtPeriodEnd(customer, true);
    const later = billing.provider.drainWebhooks();
    for (const raw of [...later, ...webhooks].reverse()) expect((await billing.webhooks.handle(raw)).status).toBe(200);
    expect(await billing.store.getSubscription(account.id)).toMatchObject({ status: "trialing", cancelAtPeriodEnd: true, priceKey: "pro_monthly_v1" });
  });

  it("processes an unknown event type as ignored", async () => {
    const billing = createTestBilling();
    billing.provider.emit({ type: "ignored", providerType: "customer.tax_id.created" });
    expect(await billing.deliverWebhooks()).toEqual([200]);
  });

  it("answers 500 on a processing failure, then succeeds on the retry", async () => {
    const billing = createTestBilling();
    const { webhooks, account } = await checkoutWebhooks(billing);
    billing.provider.failNext("fetchCustomerState");
    const raw = webhooks[0]!;
    expect((await billing.webhooks.handle(raw)).status).toBe(500);
    const event = JSON.parse(raw.body) as { id: string };
    expect(await billing.store.getProviderEvent("memory", event.id)).toMatchObject({ status: "failed" });
    expect((await billing.webhooks.handle(raw)).status).toBe(200);
    expect(await billing.store.getProviderEvent("memory", event.id)).toMatchObject({ status: "processed", error: null });
    expect((await billing.store.getAccount(account.id))?.planKey).toBe("pro");
  });

  it("answers 200 to a change of a customer that Doxa did not make, and changes nothing", async () => {
    const billing = createTestBilling();
    // For example a customer made by hand in the Stripe dashboard: no account, no Doxa metadata.
    const event = billing.provider.emit({
      type: "customer.changed",
      providerType: "customer.subscription.deleted",
      customer: { provider: "memory", customerId: "cus_foreign" },
    });
    expect(await billing.deliverWebhooks()).toEqual([200]);
    expect(await billing.store.getProviderEvent("memory", event.id)).toMatchObject({ status: "processed", error: null });
    expect(await billing.store.findAccountByProviderCustomer("memory", "cus_foreign")).toBeNull();
  });

  it("still answers 500 when a Doxa customer points to an account that does not exist", async () => {
    const billing = createTestBilling();
    const customer = await billing.provider.ensureCustomer({
      accountId: "00000000-0000-4000-8000-000000000000",
      email: null,
      name: null,
      existing: null,
      idempotencyKey: "lost-account",
    });
    const event = billing.provider.emit({ type: "customer.changed", providerType: "customer.subscription.updated", customer });
    expect(await billing.deliverWebhooks()).toEqual([500]);
    expect(await billing.store.getProviderEvent("memory", event.id)).toMatchObject({ status: "failed" });
  });

  it("answers 413 above 1 MB", async () => {
    const billing = createTestBilling();
    expect((await billing.webhooks.handle({ body: "x".repeat(1024 * 1024 + 1), headers: {} })).status).toBe(413);
  });

  it("shows Pro at once on the Checkout return, before any webhook", async () => {
    const billing = createTestBilling();
    const { link, account } = await checkoutWebhooks(billing);
    const result = await billing.payments.syncCheckout(link.checkoutId);
    expect(result).toMatchObject({ accountId: account.id, from: "free", to: "pro", changed: true });
    const view = await billing.entitlements.forAccount(account.id);
    expect(view.entitlements).toMatchObject({ plan: "pro", subscriptionStatus: "trialing" });
  });

  it("catches up on events that the webhook missed", async () => {
    const billing = createTestBilling();
    const { account } = await checkoutWebhooks(billing);
    expect(await billing.webhooks.catchUp()).toEqual({ processed: 2, failed: 0 });
    expect((await billing.store.getAccount(account.id))?.planKey).toBe("pro");
    expect(await billing.webhooks.catchUp()).toEqual({ processed: 0, failed: 0 });
  });

  it("emits billing.plan_changed once per change", async () => {
    const billing = createTestBilling();
    const changes: string[] = [];
    const { BillingPayments } = await import("../src/payments/index");
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
      events: { planChanged: ({ from, to }) => void changes.push(`${from}->${to}`) },
    });
    const { link } = await checkoutWebhooks(billing);
    await payments.syncCheckout(link.checkoutId);
    await payments.syncCheckout(link.checkoutId);
    expect(changes).toEqual(["free->pro"]);
  });
});
