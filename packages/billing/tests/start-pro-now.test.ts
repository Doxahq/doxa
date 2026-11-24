import { describe, expect, it } from "vitest";

import { BillingStateError } from "../src/errors";
import { DAY_MS, type ProviderCustomerRef } from "../src/index";
import { PAYMENT_FAILED, ProviderRejectedError } from "../src/provider/errors";
import { MEMORY_TEST_CARD, checkLedgerInvariant, createTestBilling, type TestBilling } from "../src/testing";
import { PRO_ALLOWANCE, paidProAccount, runJob } from "./helpers/pro";

/** A Pro account in its 7-day trial, with the webhooks delivered. */
async function trialingAccount(billing: TestBilling, priceKey = "pro_monthly_founder_v2") {
  const account = await billing.accounts.accountForOwner("user", "trial_user");
  const link = await billing.payments.createCheckout({ accountId: account.id, priceKey, requestId: "r1" });
  billing.provider.completeCheckout(link.checkoutId);
  await billing.deliverWebhooks();
  const customer: ProviderCustomerRef = { provider: "memory", customerId: (await billing.store.getAccount(account.id))!.providerCustomerId! };
  return { account, customer };
}

async function balanceOf(billing: TestBilling, accountId: string) {
  const view = await billing.entitlements.forAccount(accountId);
  return billing.ledger.balance(accountId, view.creditContext);
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("Start Pro now (decision D22)", () => {
  it("ends the trial, gives the full monthly allowance from now, and ends the trial credits", async () => {
    const billing = createTestBilling();
    const { account } = await trialingAccount(billing);
    await runJob(billing, account.id, "trial-job", 0.1);
    const during = await balanceOf(billing, account.id);
    expect(during.granted).toBeLessThan(1_000);
    expect(during.granted).toBeGreaterThan(0);

    billing.clock.advance(2 * DAY_MS);
    const result = await billing.payments.startProNow({ accountId: account.id, requestId: "start-1" });
    expect(result).toMatchObject({ accountId: account.id, to: "pro" });
    await billing.deliverWebhooks();

    const subscription = await billing.store.getSubscription(account.id);
    expect(subscription).toMatchObject({ status: "active", billingAnchor: billing.clock.now() });
    const after = await balanceOf(billing, account.id);
    expect(after.granted).toBe(PRO_ALLOWANCE);
    expect(after.windowStart).toEqual(billing.clock.now());

    const grants = await billing.store.listGrants(account.id);
    expect(grants.find((grant) => grant.kind === "trial")?.remaining).toBe(0);
    const ended = billing.store.allLedgerEntries(account.id).filter((entry) => entry.kind === "expire" && entry.metadata.reason === "trial_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.credits).toBe(-during.granted);
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);

    // The first paid invoice claims the founder slot (spec 7.5).
    expect((await billing.store.getOfferSlot("founder_v1", account.id))?.state).toBe("claimed");
    // A second read gives no second allowance and no second expiry.
    expect((await balanceOf(billing, account.id)).granted).toBe(PRO_ALLOWANCE);
  });

  it("a declined card changes nothing: still trialing, the trial credits stay", async () => {
    const billing = createTestBilling();
    const { account, customer } = await trialingAccount(billing);
    expect((await balanceOf(billing, account.id)).granted).toBe(1_000);
    billing.provider.setCardFails(customer, true);
    const refused = await refusal(billing.payments.startProNow({ accountId: account.id, requestId: "start-1" }));
    expect(refused).toBeInstanceOf(ProviderRejectedError);
    expect((refused as ProviderRejectedError).providerCode).toBe(PAYMENT_FAILED);
    expect((await billing.store.getSubscription(account.id))?.status).toBe("trialing");
    expect((await balanceOf(billing, account.id)).granted).toBe(1_000);
  });

  it("refuses an account that is not trialing with not_trialing", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    const free = await billing.accounts.accountForOwner("user", "free_user");
    for (const accountId of [account.id, free.id]) {
      const refused = await refusal(billing.payments.startProNow({ accountId, requestId: "start-1" }));
      expect(refused).toBeInstanceOf(BillingStateError);
      expect((refused as BillingStateError).code).toBe("not_trialing");
    }
  });

  it("a stale mirror (trialing, but the provider ended it) syncs, then refuses", async () => {
    const billing = createTestBilling();
    const { account, customer } = await trialingAccount(billing);
    billing.clock.advance(7 * DAY_MS);
    billing.provider.endTrial(customer); // the webhook has not arrived
    const refused = await refusal(billing.payments.startProNow({ accountId: account.id, requestId: "start-1" }));
    expect((refused as BillingStateError).code).toBe("not_trialing");
    expect((await billing.store.getSubscription(account.id))?.status).toBe("active");
  });

  it("previews the charge and the interval of the plan price", async () => {
    const billing = createTestBilling();
    const { account } = await trialingAccount(billing, "pro_yearly_founder_v2");
    expect(await billing.payments.previewStartProNow(account.id)).toEqual({ amountCents: 118_800, currency: "usd", intervalLabel: "year" });
    const { account: paid } = await paidProAccount(billing);
    expect(((await refusal(billing.payments.previewStartProNow(paid.id))) as BillingStateError).code).toBe("not_trialing");
  });
});

describe("plan interval preview", () => {
  it("previews the switch with the new price and interval", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    billing.clock.advance(15 * DAY_MS);
    const preview = await billing.payments.previewPlanInterval({ accountId: account.id, interval: "year" });
    expect(preview.newPriceCents).toBe(202_800);
    expect(preview.newInterval).toBe("year");
    expect(preview.creditCents).toBeGreaterThan(0);
    expect(preview.chargeTodayCents).toBe(202_800 - preview.creditCents);
    expect(preview.balanceAfterCents).toBe(0);
    // A preview changes nothing.
    expect((await billing.store.getSubscription(account.id))?.priceKey).toBe("pro_monthly_v1");
  });

  it("refuses the same interval and an account without a subscription", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    expect(((await refusal(billing.payments.previewPlanInterval({ accountId: account.id, interval: "month" }))) as BillingStateError).code).toBe("same_interval");
    const free = await billing.accounts.accountForOwner("user", "free_user");
    expect(((await refusal(billing.payments.previewPlanInterval({ accountId: free.id, interval: "year" }))) as BillingStateError).code).toBe("no_subscription");
  });
});

describe("card on file", () => {
  it("reads the card that a paid Checkout saved", async () => {
    const billing = createTestBilling();
    const { account } = await trialingAccount(billing);
    expect(await billing.payments.readPaymentMethod(account.id)).toEqual(MEMORY_TEST_CARD);
  });

  it("is null without a customer, and null plus a count when the provider fails", async () => {
    const billing = createTestBilling();
    const free = await billing.accounts.accountForOwner("user", "free_user");
    expect(await billing.payments.readPaymentMethod(free.id)).toBeNull();
    const { account } = await trialingAccount(billing);
    billing.provider.failNext("fetchPaymentMethod");
    expect(await billing.payments.readPaymentMethod(account.id)).toBeNull();
    expect(billing.counters.at(-1)).toEqual({
      name: "billing.payment_method_unavailable",
      fields: { accountId: account.id, error: "ProviderUnavailableError", message: "memory provider: fetchPaymentMethod failed" },
    });
  });
});
