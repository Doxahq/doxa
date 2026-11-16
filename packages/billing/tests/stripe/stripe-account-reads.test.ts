import { describe, expect, it } from "vitest";

import { NOT_TRIALING, PAYMENT_FAILED, ProviderRejectedError, ProviderUnavailableError } from "../../src/provider/errors";
import { checkoutInput, priceId, stripeKit, syncCatalog, type StripeTestKit } from "./helpers";

const CARD = { brand: "visa", last4: "4242", expMonth: 8, expYear: 2031 };
const DAY_MS = 86_400_000;

async function subscribed(kit: StripeTestKit, options: { priceKey?: string; trialDays?: number | null } = {}) {
  await syncCatalog(kit);
  const ref = await kit.provider.ensureCustomer({ accountId: "acct_1", email: null, name: null, existing: null, idempotencyKey: "customer:acct_1" });
  const input = checkoutInput(ref.customerId, options.priceKey ?? "pro_monthly_founder_v1", kit.catalog, kit.clock);
  const link = await kit.provider.createCheckout({ ...input, trialDays: options.trialDays ?? null });
  const subscription = kit.fake.completeSession(link.checkoutId);
  return { ref, subscriptionId: String(subscription.id) };
}

function requestCount(kit: StripeTestKit): number {
  return kit.fake.requests.length;
}

describe("stripe provider: card on file", () => {
  it("reads the subscription's default card first, in one call", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit);
    kit.fake.addCard(ref.customerId, { brand: "mastercard", last4: "4444", expMonth: 1, expYear: 2029 });
    kit.fake.addCard(ref.customerId, CARD, { subscriptionId });
    const before = requestCount(kit);
    expect(await kit.provider.fetchPaymentMethod({ customer: ref, subscriptionId })).toEqual(CARD);
    expect(requestCount(kit) - before).toBe(1);
    const { params } = kit.fake.requestsTo("GET", `/v1/subscriptions/${subscriptionId}`).at(-1)!;
    expect(params.expand).toEqual(["default_payment_method", "customer.invoice_settings.default_payment_method"]);
  });

  it("falls back to the customer's invoice default, with or without a subscription", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit);
    kit.fake.addCard(ref.customerId, CARD);
    expect(await kit.provider.fetchPaymentMethod({ customer: ref, subscriptionId })).toEqual(CARD);
    const before = requestCount(kit);
    expect(await kit.provider.fetchPaymentMethod({ customer: ref, subscriptionId: null })).toEqual(CARD);
    expect(requestCount(kit) - before).toBe(1);
  });

  it("is null without a card, and refuses another customer's subscription", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit);
    expect(await kit.provider.fetchPaymentMethod({ customer: ref, subscriptionId })).toBeNull();
    const other = await kit.provider.ensureCustomer({ accountId: "acct_2", email: null, name: null, existing: null, idempotencyKey: "customer:acct_2" });
    await expect(kit.provider.fetchPaymentMethod({ customer: other, subscriptionId })).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it("maps a Stripe outage to ProviderUnavailableError", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit);
    kit.fake.failNext = 1;
    await expect(kit.provider.fetchPaymentMethod({ customer: ref, subscriptionId })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("stripe provider: Start Pro now (D22)", () => {
  it("ends the trial now with an idempotency key; the anchor resets and the first invoice is paid", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit, { trialDays: 7 });
    kit.clock.advance(2 * DAY_MS);
    await kit.provider.endTrialNow({ customer: ref, subscriptionId, idempotencyKey: "start-pro-now:1" });
    const update = kit.fake.requestsTo("POST", `/v1/subscriptions/${subscriptionId}`).at(-1)!;
    expect(update.params).toEqual({ trial_end: "now", payment_behavior: "error_if_incomplete" });
    expect(update.headers["idempotency-key"]).toBe("start-pro-now:1");
    const state = await kit.provider.fetchCustomerState(ref);
    expect(state.subscription).toMatchObject({ status: "active", billingAnchor: kit.clock.now(), trialEnd: kit.clock.now() });
    expect(state.firstPaidInvoiceAt).toEqual(kit.clock.now());
  });

  it("refuses a subscription that is not trialing", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit);
    const refused = await kit.provider.endTrialNow({ customer: ref, subscriptionId, idempotencyKey: "k" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderRejectedError);
    expect((refused as ProviderRejectedError).providerCode).toBe(NOT_TRIALING);
  });

  it("a declined card leaves the trial as it was", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit, { trialDays: 7 });
    kit.fake.declineNextPayment(ref.customerId);
    const refused = await kit.provider.endTrialNow({ customer: ref, subscriptionId, idempotencyKey: "k" }).catch((error: unknown) => error);
    expect((refused as ProviderRejectedError).providerCode).toBe(PAYMENT_FAILED);
    expect((await kit.provider.fetchCustomerState(ref)).subscription?.status).toBe("trialing");
  });

  it("previews the first charge with an invoice preview, and creates nothing", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit, { trialDays: 7 });
    expect(await kit.provider.previewTrialEnd({ customer: ref, subscriptionId })).toEqual({ amountDueCents: 15_900, currency: "usd" });
    const { params } = kit.fake.requestsTo("POST", "/v1/invoices/create_preview").at(-1)!;
    expect(params).toEqual({ customer: ref.customerId, subscription: subscriptionId, subscription_details: { trial_end: "now" } });
    expect((await kit.provider.fetchCustomerState(ref)).subscription?.status).toBe("trialing");
  });
});

describe("stripe provider: plan switch preview", () => {
  it("previews the same items and proration as the real switch", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit);
    kit.clock.advance(15 * DAY_MS);
    const preview = await kit.provider.previewPlanSwitch({ customer: ref, subscriptionId, priceKey: "pro_yearly_founder_v1" });
    // 15 of 30 days unused on $159: $79.50 credit; the yearly $1,548 minus it is due now.
    expect(preview).toEqual({ chargeTodayCents: 154_800 - 7_950, creditCents: 7_950, balanceAfterCents: 0 });
    const previewItems = kit.fake.requestsTo("POST", "/v1/invoices/create_preview").at(-1)!.params.subscription_details;
    await kit.provider.switchPlanPrice({ customer: ref, subscriptionId, priceKey: "pro_yearly_founder_v1", idempotencyKey: "switch:1" });
    const update = kit.fake.requestsTo("POST", `/v1/subscriptions/${subscriptionId}`).at(-1)!.params;
    expect(previewItems).toEqual({ items: update.items, proration_behavior: update.proration_behavior });
    expect(update.proration_behavior).toBe("create_prorations");
    expect(update.items).toEqual([
      expect.objectContaining({ price: priceId(kit, "pro_yearly_founder_v1") }),
      expect.objectContaining({ deleted: "true" }),
      { price: priceId(kit, "ai_usage_yearly_v1") },
    ]);
  });

  it("reports a credit larger than the new price as a balance for later invoices", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await subscribed(kit, { priceKey: "pro_yearly_founder_v1" });
    const preview = await kit.provider.previewPlanSwitch({ customer: ref, subscriptionId, priceKey: "pro_monthly_founder_v1" });
    expect(preview).toEqual({ chargeTodayCents: 0, creditCents: 154_800, balanceAfterCents: 154_800 - 15_900 });
  });
});
