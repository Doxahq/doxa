import { describe, expect, it } from "vitest";

import {
  BillingConfigurationError,
  DAY_MS,
  DOXA_CATALOG,
  MINUTE_MS,
  OfferClosedError,
  defineCatalog,
  readBillingConfig,
  type ProviderCustomerRef,
} from "../src/index";
import { createTestBilling, insertLegacyHeldReservation, type TestBilling } from "../src/testing";
import { accountWithCredits } from "./helpers/fixtures";
import { paidProAccount, runJob } from "./helpers/pro";

/**
 * Regression tests for the money findings of the billing review (M1–M6 and
 * the founder cap). Each test fails on the code before the fix.
 */

const smallOffer = (maxAccounts: number) =>
  defineCatalog({ ...DOXA_CATALOG, offers: { founder_v1: { ...DOXA_CATALOG.offers.founder_v1, maxAccounts } } });

async function customerOf(billing: TestBilling, accountId: string): Promise<ProviderCustomerRef> {
  return { provider: "memory", customerId: (await billing.store.getAccount(accountId))!.providerCustomerId! };
}

/** A founder who paid (claimed slot), then cancelled. */
async function lapsedFounder(billing: TestBilling, owner: string) {
  const account = await billing.accounts.accountForOwner("user", owner);
  const link = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_founder_v2", requestId: "r1" });
  billing.provider.completeCheckout(link.checkoutId);
  await billing.deliverWebhooks();
  const customer = await customerOf(billing, account.id);
  billing.provider.endTrial(customer);
  await billing.deliverWebhooks();
  expect(await billing.store.getOfferSlot("founder_v1", account.id)).toMatchObject({ state: "claimed" });
  billing.provider.setSubscriptionStatus(customer, "canceled");
  await billing.deliverWebhooks();
  return { account, customer };
}

describe("M1: a founder who cancelled pays the price of that day", () => {
  it("refuses the founder price again once the offer is full", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const { account } = await lapsedFounder(billing, "a");
    const error = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_founder_v2", requestId: "r2" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OfferClosedError);
    expect(error).toMatchObject({ newPriceKey: "pro_monthly_v1" });
    // The claimed slot stays claimed: the offer means "the first N paying customers".
    expect(await billing.store.getOfferSlot("founder_v1", account.id)).toMatchObject({ state: "claimed" });
  });

  it("gives the founder price again while the offer still has room, without a second slot", async () => {
    const billing = createTestBilling({ catalog: smallOffer(2) });
    const { account } = await lapsedFounder(billing, "a");
    const link = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_founder_v2", requestId: "r2" });
    expect(billing.provider.checkoutRow(link.checkoutId)?.priceKey).toBe("pro_monthly_founder_v2");
    expect((await billing.offers.describe("founder_v1")).slotsLeft).toBe(1);
  });
});

describe("M2: one account never opens two paid subscriptions", () => {
  it("returns the same open Checkout to a second tab or a retry", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "a");
    const first = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "tab1" });
    const second = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "tab2" });
    expect(second).toEqual(first);
    expect(billing.provider.checkoutRequests).toHaveLength(1);
  });

  it("refuses a concurrent second request while the first one creates the Checkout", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "a");
    const results = await Promise.allSettled([
      billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "tab1" }),
      billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "tab2" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(billing.provider.checkoutRequests).toHaveLength(1);
    expect(fulfilled).toHaveLength(1);
    expect(refused.map((result) => (result as PromiseRejectedResult).reason)).toMatchObject([{ code: "checkout_in_progress" }]);
  });

  it("expires the open Checkout of another price before it opens a new one", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "a");
    const monthly = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    const yearly = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_yearly_v1", requestId: "r2" });
    expect(yearly.checkoutId).not.toBe(monthly.checkoutId);
    expect(billing.provider.checkoutRow(monthly.checkoutId)?.status).toBe("expired");
    expect(() => billing.provider.completeCheckout(monthly.checkoutId)).toThrow(/expired/);
  });

  it("opens a new Checkout after the stored one expired", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "a");
    const first = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    billing.clock.advance(32 * MINUTE_MS);
    const second = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r2" });
    expect(second.checkoutId).not.toBe(first.checkoutId);
  });

  it("refuses a Checkout when the provider has a live subscription that the mirror does not know yet", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "a");
    const first = await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1" });
    billing.provider.completeCheckout(first.checkoutId);
    billing.provider.drainWebhooks(); // the webhook is late: the mirror has no subscription
    expect(await billing.store.getSubscription(account.id)).toBeNull();
    await expect(billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_yearly_v1", requestId: "r2" })).rejects.toMatchObject({
      code: "already_subscribed",
    });
  });

  it.each(["incomplete", "unpaid", "paused"] as const)("refuses a Checkout for a %s subscription", async (status) => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    billing.provider.setSubscriptionStatus(customer, status);
    await billing.deliverWebhooks();
    await expect(billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_yearly_v1", requestId: "r9" })).rejects.toMatchObject({
      code: "already_subscribed",
    });
  });

  it("logs a duplicate subscription and keeps mirroring the oldest paid one", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    const oldest = (await billing.store.getSubscription(account.id))!.providerSubscriptionId;
    // A second paid subscription made outside Doxa's checks (for example by hand in the provider).
    const extra = await billing.provider.createCheckout({
      accountId: account.id,
      customer,
      priceKey: "pro_yearly_v1",
      usagePriceKey: "ai_usage_yearly_v1",
      trialDays: null,
      expiresAt: new Date(billing.clock.now().getTime() + 31 * MINUTE_MS),
      successUrl: "https://doxa.test/ok",
      cancelUrl: "https://doxa.test/cancel",
      idempotencyKey: "extra",
    });
    billing.provider.completeCheckout(extra.checkoutId);
    await billing.deliverWebhooks();
    expect(billing.counters.filter((row) => row.name === "billing.duplicate_subscription")).not.toHaveLength(0);
    expect((await billing.store.getSubscription(account.id))?.providerSubscriptionId).toBe(oldest);
    expect(billing.provider.subscriptionsOf(customer).every((sub) => sub.status === "active")).toBe(true);
  });
});

describe("M3: settle charges the consumed cost under the lock", () => {
  it("charges an accrual that commits between the settle's first read and its lock", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 5_000);
    const subject = { kind: "job", id: "gap" };
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0, capCredits: 3_000 });
    await billing.meter.accrue({ subject, callId: "c1", costUsd: 0.1 });

    // Run one accrual right before the settle's account lock, after the meter read the reservation.
    const original = billing.store.withAccountLock.bind(billing.store);
    let injected = false;
    billing.store.withAccountLock = (async (accountId, now, fn) => {
      if (!injected) {
        injected = true;
        await billing.meter.accrue({ subject, callId: "c2", costUsd: 1 });
      }
      return original(accountId, now, fn);
    }) as typeof billing.store.withAccountLock;
    const result = await billing.meter.settle({ subject, outcome: "succeeded" });
    billing.store.withAccountLock = original;

    // 50 base + ceil(1.10 × 300) = 380.
    expect(injected).toBe(true);
    expect(result).toMatchObject({ outcome: "settled", charged: 380, price: 380 });
  });
});

describe("M4: a resumed job settles every hold", () => {
  async function resumedJob() {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 5_000);
    const subject = { kind: "job", id: "resumed" };
    const first = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0, capCredits: 3_000 });
    if (first.kind !== "reserved") throw new Error("the first admission holds credits");
    await billing.meter.accrue({ subject, callId: "a1", costUsd: 0.1 });
    billing.clock.advance(MINUTE_MS);
    // A resume keeps the job ID. Two held holds of one job are a state from
    // before the ledger refused a second one; settle and release still handle it.
    await insertLegacyHeldReservation(billing.store, first.reservation, {
      idempotencyKey: "job:resumed:reserve:2",
      baseCredits: 0,
      amount: 100,
      at: billing.clock.now(),
    });
    await billing.meter.accrue({ subject, callId: "b1", costUsd: 0.2 });
    return { billing, account, subject };
  }

  it("settles both reservations, oldest first, and leaves nothing held", async () => {
    const { billing, account, subject } = await resumedJob();
    const result = await billing.meter.settle({ subject, outcome: "succeeded" });
    // (50 + 30) + 60: the job pays the base fee once, with its first hold.
    expect(result).toMatchObject({ outcome: "settled", charged: 140 });
    const rows = await billing.store.listReservationsBySubject("job", "resumed");
    expect(rows.map((row) => [row.status, row.baseCredits, row.settledAmount])).toEqual([
      ["settled", 50, 80],
      ["settled", 0, 60],
    ]);
    const view = await billing.entitlements.forAccount(account.id);
    expect((await billing.ledger.balance(account.id, view.creditContext)).held).toBe(0);
    expect((await billing.meter.settle({ subject, outcome: "succeeded" })).outcome).toBe("replayed");
  });

  it("releases every held reservation of a job that is gone", async () => {
    const { billing, subject } = await resumedJob();
    expect((await billing.meter.release({ subject, reason: "job_gone" })).outcome).toBe("released");
    expect((await billing.store.listReservationsBySubject("job", "resumed")).map((row) => row.status)).toEqual(["released", "released"]);
  });
});

describe("M5: the monthly sweep catches up and runs once for each window", () => {
  it("runs once in a window, again in the next window, and after a missed month", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    expect((await billing.payments.runMonthlySweep(account.id)).ran).toBe(true);
    expect((await billing.payments.runMonthlySweep(account.id)).ran).toBe(false);
    billing.clock.advance(40 * DAY_MS); // a tick a month later, days after the anchor
    await runJob(billing, account.id, "late", 0.1);
    expect((await billing.payments.runMonthlySweep(account.id)).ran).toBe(true);
    const swept = (await billing.store.getAccount(account.id))!.paygSweptWindowStart!;
    expect(swept.getTime()).toBeLessThanOrEqual(billing.clock.now().getTime());
    expect((await billing.payments.runMonthlySweep(account.id)).ran).toBe(false);
  });
});

describe("M6: the memory provider is for tests only", () => {
  it("refuses BILLING_PROVIDER=memory outside a test runner", () => {
    expect(() => readBillingConfig({ BILLING_PROVIDER: "memory" }, { dashboardUrl: "https://doxa.test", allowMemoryProvider: false })).toThrow(BillingConfigurationError);
    expect(readBillingConfig({ BILLING_PROVIDER: "memory" }, { dashboardUrl: "https://doxa.test" }).provider).toBe("memory");
  });
});

describe("founder cap: a lapsed hold whose payment is coming keeps counting", () => {
  it("keeps the hold of a completed Checkout whose webhook is late, so the next account gets the then price", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await billing.accounts.accountForOwner("user", "a");
    const b = await billing.accounts.accountForOwner("user", "b");
    const link = await billing.payments.createCheckout({ accountId: a.id, priceKey: "pro_monthly_founder_v2", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    const late = billing.provider.drainWebhooks(); // the API is paused: the webhooks wait
    billing.clock.advance(40 * MINUTE_MS);
    expect(await billing.payments.releaseExpiredHolds()).toEqual({ released: 0, kept: 1 });
    await expect(billing.payments.createCheckout({ accountId: b.id, priceKey: "pro_monthly_founder_v2", requestId: "r2" })).rejects.toBeInstanceOf(OfferClosedError);
    for (const raw of late) await billing.webhooks.handle(raw);
    expect((await billing.offers.describe("founder_v1")).slotsLeft).toBe(0);
  });

  it("releases a lapsed hold whose Checkout expired", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await billing.accounts.accountForOwner("user", "a");
    const link = await billing.payments.createCheckout({ accountId: a.id, priceKey: "pro_monthly_founder_v2", requestId: "r1" });
    await billing.provider.expireCheckout(link.checkoutId);
    billing.provider.drainWebhooks();
    billing.clock.advance(40 * MINUTE_MS);
    expect(await billing.payments.releaseExpiredHolds()).toEqual({ released: 1, kept: 0 });
    expect(await billing.store.getOfferSlot("founder_v1", a.id)).toMatchObject({ state: "released" });
  });

  it("keeps a trial hold past the trial end until the first invoice is paid", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await billing.accounts.accountForOwner("user", "a");
    const link = await billing.payments.createCheckout({ accountId: a.id, priceKey: "pro_monthly_founder_v2", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    await billing.deliverWebhooks();
    billing.clock.advance(7 * DAY_MS + MINUTE_MS); // the first invoice is still a draft at the provider
    expect(await billing.payments.releaseExpiredHolds()).toEqual({ released: 0, kept: 1 });
    expect((await billing.offers.describe("founder_v1")).slotsLeft).toBe(0);
  });

  it("claims and logs a founder price that was paid after the offer filled", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await billing.accounts.accountForOwner("user", "a");
    const b = await billing.accounts.accountForOwner("user", "b");
    await billing.offers.hold({ offerKey: "founder_v1", accountId: a.id });
    billing.clock.advance(40 * MINUTE_MS);
    await billing.offers.release({ offerKey: "founder_v1", accountId: a.id });
    await billing.offers.hold({ offerKey: "founder_v1", accountId: b.id });
    await billing.offers.claim({ offerKey: "founder_v1", accountId: b.id });
    expect(await billing.offers.claim({ offerKey: "founder_v1", accountId: a.id })).toEqual({ claimed: true, overCap: true });
    expect(await billing.store.getOfferSlot("founder_v1", a.id)).toMatchObject({ state: "claimed" });
    expect((await billing.offers.describe("founder_v1")).slotsLeft).toBe(0);
  });
});
