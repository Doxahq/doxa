import { describe, expect, it } from "vitest";

import { DAY_MS, DOXA_CATALOG, MINUTE_MS, OfferClosedError, defineCatalog } from "../src/index";
import { createTestBilling } from "../src/testing";

const smallOffer = (maxAccounts: number) =>
  defineCatalog({ ...DOXA_CATALOG, offers: { founder_v1: { ...DOXA_CATALOG.offers.founder_v1, maxAccounts } } });

async function owner(billing: ReturnType<typeof createTestBilling>, name: string) {
  return billing.accounts.accountForOwner("user", name);
}

describe("founder slots", () => {
  it("holds a slot at Checkout and releases it when the Checkout expires", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await owner(billing, "a");
    const link = await billing.payments.createCheckout({ accountId: a.id, priceKey: "pro_yearly_founder_v2", requestId: "r1" });
    expect(await billing.store.getOfferSlot("founder_v1", a.id)).toMatchObject({ state: "held", checkoutSessionId: link.checkoutId });
    expect((await billing.offers.describe("founder_v1")).slotsLeft).toBe(0);

    billing.provider.expireCheckout(link.checkoutId);
    await billing.deliverWebhooks();
    expect(await billing.store.getOfferSlot("founder_v1", a.id)).toMatchObject({ state: "released" });
    expect((await billing.offers.describe("founder_v1")).slotsLeft).toBe(1);
  });

  it("frees an expired hold for the count, and the cron releases it", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await owner(billing, "a");
    const b = await owner(billing, "b");
    await billing.offers.hold({ offerKey: "founder_v1", accountId: a.id });
    expect((await billing.offers.hold({ offerKey: "founder_v1", accountId: b.id })).granted).toBe(false);
    billing.clock.advance(31 * MINUTE_MS);
    expect(await billing.offers.releaseExpired()).toBe(1);
    expect((await billing.offers.hold({ offerKey: "founder_v1", accountId: b.id })).granted).toBe(true);
  });

  it("holds through the trial and claims at the first paid invoice", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await owner(billing, "a");
    const link = await billing.payments.createCheckout({ accountId: a.id, priceKey: "pro_monthly_founder_v2", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    await billing.deliverWebhooks();
    const held = await billing.store.getOfferSlot("founder_v1", a.id);
    expect(held?.state).toBe("held");
    expect(held?.heldUntil?.getTime()).toBe(billing.clock.now().getTime() + 7 * DAY_MS);

    billing.clock.advance(7 * DAY_MS - MINUTE_MS);
    expect(await billing.offers.releaseExpired()).toBe(0); // the trial keeps the hold past the 30-minute Checkout hold
    const customer = { provider: "memory" as const, customerId: (await billing.store.getAccount(a.id))!.providerCustomerId! };
    billing.provider.endTrial(customer);
    await billing.deliverWebhooks();
    expect(await billing.store.getOfferSlot("founder_v1", a.id)).toMatchObject({ state: "claimed" });
  });

  it("releases the slot when the trial ends without a payment", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await owner(billing, "a");
    const link = await billing.payments.createCheckout({ accountId: a.id, priceKey: "pro_monthly_founder_v2", requestId: "r1" });
    billing.provider.completeCheckout(link.checkoutId);
    await billing.deliverWebhooks();
    const customer = { provider: "memory" as const, customerId: (await billing.store.getAccount(a.id))!.providerCustomerId! };
    billing.provider.setSubscriptionStatus(customer, "incomplete_expired");
    await billing.deliverWebhooks();
    expect(await billing.store.getOfferSlot("founder_v1", a.id)).toMatchObject({ state: "released" });
  });

  it("never reopens a claimed slot, and the next account gets the then price with offer_closed", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await owner(billing, "a");
    const b = await owner(billing, "b");
    await billing.offers.hold({ offerKey: "founder_v1", accountId: a.id });
    expect(await billing.offers.claim({ offerKey: "founder_v1", accountId: a.id })).toEqual({ claimed: true, overCap: false });
    await billing.offers.release({ offerKey: "founder_v1", accountId: a.id });
    expect(await billing.store.getOfferSlot("founder_v1", a.id)).toMatchObject({ state: "claimed" });

    const error = await billing.payments.createCheckout({ accountId: b.id, priceKey: "pro_yearly_founder_v2", requestId: "r2" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OfferClosedError);
    expect(error).toMatchObject({ code: "offer_closed", newPriceKey: "pro_yearly_v1" });
    const view = await billing.offers.describe("founder_v1");
    expect(view).toMatchObject({ open: false, prices: { year: { priceKey: "pro_yearly_v1" } } });
    const link = await billing.payments.createCheckout({ accountId: b.id, priceKey: "pro_yearly_v1", requestId: "r3" });
    expect(billing.provider.checkoutRow(link.checkoutId)?.priceKey).toBe("pro_yearly_v1");
  });

  it("gives the 51st account the then price: 60 parallel founder Checkouts, 50 slots", async () => {
    const billing = createTestBilling();
    const accounts = await Promise.all(Array.from({ length: 60 }, (_, index) => owner(billing, `u${index}`)));
    const results = await Promise.allSettled(
      accounts.map((account, index) => billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_founder_v2", requestId: `r${index}` })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(50);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof OfferClosedError)).toHaveLength(10);
  });

  it("releases a fresh hold when the provider fails to create the Checkout", async () => {
    const billing = createTestBilling({ catalog: smallOffer(1) });
    const a = await owner(billing, "a");
    billing.provider.failNext("createCheckout");
    await expect(billing.payments.createCheckout({ accountId: a.id, priceKey: "pro_monthly_founder_v2", requestId: "r1" })).rejects.toThrow();
    expect(await billing.store.getOfferSlot("founder_v1", a.id)).toMatchObject({ state: "released" });
  });

  it("opens the founder Portal configuration for founders only", async () => {
    const billing = createTestBilling();
    const founder = await owner(billing, "f");
    const standard = await owner(billing, "s");
    for (const [account, priceKey] of [[founder, "pro_monthly_founder_v2"], [standard, "pro_monthly_v1"]] as const) {
      const link = await billing.payments.createCheckout({ accountId: account.id, priceKey, requestId: "r" });
      billing.provider.completeCheckout(link.checkoutId);
      await billing.deliverWebhooks();
      await billing.payments.createPortalSession({ accountId: account.id });
    }
    expect(billing.provider.portalSessions.map((session) => session.configuration)).toEqual(["founder", "standard"]);
  });
});
