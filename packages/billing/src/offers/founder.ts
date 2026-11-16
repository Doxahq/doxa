import type { Catalog } from "../catalog/define";
import { describeOffer, type OfferView } from "../catalog/display";
import type { BillingInterval } from "../catalog/keys";
import { MINUTE_MS, addMs, type Clock } from "../clock";
import { BillingNotFoundError } from "../errors";
import { isLiveSubscriptionStatus } from "../provider/provider";
import type { BillingStore } from "../store/store";
import type { OfferSlot } from "../store/types";

/**
 * Founder slots (spec 7.5, decisions D4 and D15). A slot is `held` while a
 * Checkout or a trial runs, `claimed` at the first paid invoice above 0, and
 * `released` when the Checkout expires or the trial ends without a payment.
 * Held and claimed slots count toward `maxAccounts`. A claimed slot never
 * opens again. One slot for each billing account.
 */

/** The Checkout Session lifetime, the Stripe minimum. The hold ends with it. */
// Stripe needs a Checkout Session to live at least 30 minutes by its own
// clock, so the Checkout and the founder hold both last 31 minutes.
export const CHECKOUT_HOLD_MS = 31 * MINUTE_MS;

export type HoldResult =
  | { readonly granted: true; readonly slot: OfferSlot }
  /** The offer is full: Checkout must use `then` after the customer accepts the new price. */
  | { readonly granted: false; readonly thenPrices: Readonly<Record<BillingInterval, string>> };

export class OfferSlots {
  constructor(private readonly deps: { readonly store: BillingStore; readonly catalog: Catalog; readonly clock: Clock }) {}

  private offer(offerKey: string) {
    const offer = this.deps.catalog.offers[offerKey];
    if (!offer) throw new BillingNotFoundError(`Unknown offer ${offerKey}.`);
    return offer;
  }

  /**
   * Holds a slot under the offer lock (spec 7.5 rule 2). An account with a
   * live hold keeps it; a new or released slot needs room.
   *
   * A claimed slot grants the founder price only while the account has a
   * live subscription on a price of this offer (spec 7.5 rule 4: a founder
   * keeps the price while subscribed). A founder who cancelled is a new
   * customer: the price of that day, so `then` once the offer is full. The
   * claimed slot stays claimed (rule 3) and is not held again.
   *
   * spec: the count uses the catalog's `maxAccounts`; the `billing_offers`
   * row is the lock row only.
   */
  async hold(input: { offerKey: string; accountId: string; heldUntil?: Date; checkoutSessionId?: string | null }): Promise<HoldResult> {
    const offer = this.offer(input.offerKey);
    const now = this.deps.clock.now();
    const heldUntil = input.heldUntil ?? addMs(now, CHECKOUT_HOLD_MS);
    return this.deps.store.withOfferLock(input.offerKey, now, async (tx) => {
      const existing = await tx.getSlot(input.accountId);
      if (existing?.state === "claimed") {
        if (await this.subscribedToOffer(input.accountId, offer.prices)) return { granted: true, slot: existing };
        // The slot counts in `countTaken` for all time, so the offer is open for
        // this account only while a slot is left for a new customer.
        if ((await tx.countTaken()) >= offer.maxAccounts) return { granted: false, thenPrices: offer.then };
        return { granted: true, slot: existing };
      }
      const liveHold = existing?.state === "held" && existing.heldUntil !== null && existing.heldUntil > now;
      if (!liveHold && (await tx.countTaken()) >= offer.maxAccounts) return { granted: false, thenPrices: offer.then };
      const slot = await tx.upsertSlot({
        accountId: input.accountId,
        state: "held",
        // Each hold is for a new Checkout (`attachCheckout` stores it): the
        // `checkout.session.expired` of an older one must not release this hold.
        checkoutSessionId: input.checkoutSessionId ?? null,
        heldUntil: liveHold && existing.heldUntil && existing.heldUntil > heldUntil ? existing.heldUntil : heldUntil,
        claimedAt: null,
      });
      return { granted: true, slot };
    });
  }

  /** Stores the Checkout Session ID on the hold, so `checkout.session.expired` can release it. */
  async attachCheckout(input: { offerKey: string; accountId: string; checkoutSessionId: string }): Promise<void> {
    await this.update(input.offerKey, input.accountId, (slot) =>
      slot.state === "held" ? { ...slot, checkoutSessionId: input.checkoutSessionId } : null,
    );
  }

  /** A trial started: the hold lasts until the trial ends. */
  async holdThroughTrial(input: { offerKey: string; accountId: string; trialEnd: Date }): Promise<void> {
    await this.update(input.offerKey, input.accountId, (slot) =>
      slot.state === "held" && (slot.heldUntil === null || slot.heldUntil < input.trialEnd) ? { ...slot, heldUntil: input.trialEnd } : null,
    );
  }

  /**
   * The first paid invoice above 0 on a price of the offer: claims the slot.
   * The customer paid the founder price, and Doxa never takes back a price
   * that Checkout already charged, so the claim always happens and counts.
   * `overCap` is true when the hold had lapsed and the offer was already
   * full: the caller logs `billing.founder_over_cap`. The cron keeps a hold
   * whose payment is still coming (`BillingPayments.releaseExpiredHolds`),
   * so this needs a webhook that came after the hold lapsed.
   */
  async claim(input: { offerKey: string; accountId: string }): Promise<{ readonly claimed: true; readonly overCap: boolean }> {
    const offer = this.offer(input.offerKey);
    const now = this.deps.clock.now();
    return this.deps.store.withOfferLock(input.offerKey, now, async (tx) => {
      const existing = await tx.getSlot(input.accountId);
      if (existing?.state === "claimed") return { claimed: true, overCap: false };
      const liveHold = existing?.state === "held" && existing.heldUntil !== null && existing.heldUntil > now;
      const overCap = !liveHold && (await tx.countTaken()) >= offer.maxAccounts;
      await tx.upsertSlot({
        accountId: input.accountId,
        state: "claimed",
        checkoutSessionId: existing?.checkoutSessionId ?? null,
        heldUntil: null,
        claimedAt: now,
      });
      return { claimed: true, overCap };
    });
  }

  /**
   * Keeps a lapsed hold whose payment is still coming (a completed Checkout
   * whose webhook is late, a trial whose first invoice is not paid yet), so
   * the slot keeps counting until the payment claims it or the subscription ends.
   */
  async extendHold(input: { offerKey: string; accountId: string; heldUntil: Date }): Promise<void> {
    await this.update(input.offerKey, input.accountId, (slot) =>
      slot.state === "held" && (slot.heldUntil === null || slot.heldUntil < input.heldUntil) ? { ...slot, heldUntil: input.heldUntil } : null,
    );
  }

  /** Holds whose `held_until` passed, for the cron. */
  async listExpiredHolds(): Promise<OfferSlot[]> {
    return this.deps.store.listExpiredOfferHolds(this.deps.clock.now());
  }

  /** Checkout expired or the trial ended without a payment. A claimed slot stays claimed. */
  async release(input: { offerKey: string; accountId: string }): Promise<void> {
    await this.update(input.offerKey, input.accountId, (slot) => (slot.state === "held" ? { ...slot, state: "released", heldUntil: null } : null));
  }

  async releaseByCheckout(checkoutSessionId: string): Promise<boolean> {
    const slot = await this.deps.store.findOfferSlotByCheckout(checkoutSessionId);
    if (!slot || slot.state !== "held") return false;
    await this.release({ offerKey: slot.offerKey, accountId: slot.accountId });
    return true;
  }

  /** The 5-minute cron: releases expired holds. */
  async releaseExpired(): Promise<number> {
    const expired = await this.deps.store.listExpiredOfferHolds(this.deps.clock.now());
    for (const slot of expired) await this.release({ offerKey: slot.offerKey, accountId: slot.accountId });
    return expired.length;
  }

  /**
   * `GET /billing/offers`: open, slots left and the prices that a new
   * Checkout uses. A pure read: no lock and no insert (the route is public).
   * A missing offer row counts 0 taken. Checkout still decides under the lock.
   */
  async describe(offerKey: string): Promise<OfferView> {
    this.offer(offerKey);
    const taken = await this.deps.store.countOfferTaken(offerKey, this.deps.clock.now());
    return describeOffer(this.deps.catalog, offerKey, taken);
  }

  /** True when the account's subscription mirror is live on one of the offer's prices. */
  private async subscribedToOffer(accountId: string, prices: Readonly<Record<BillingInterval, string>>): Promise<boolean> {
    const subscription = await this.deps.store.getSubscription(accountId);
    return subscription !== null && isLiveSubscriptionStatus(subscription.status) && Object.values(prices).includes(subscription.priceKey);
  }

  private async update(offerKey: string, accountId: string, change: (slot: OfferSlot) => OfferSlot | null): Promise<void> {
    this.offer(offerKey);
    await this.deps.store.withOfferLock(offerKey, this.deps.clock.now(), async (tx) => {
      const slot = await tx.getSlot(accountId);
      if (!slot) return;
      const next = change(slot);
      if (next) await tx.upsertSlot(next);
    });
  }
}
