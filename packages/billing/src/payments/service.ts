import { checkoutReturnPathProblem, type BillingPlanIntervalPreview, type BillingStartProNowPreview } from "@doxahq/contracts/billing";

import type { Catalog } from "../catalog/define";
import { findOfferOfPrice } from "../catalog/display";
import type { PlanKey } from "../catalog/keys";
import { addMs, type Clock } from "../clock";
import { allowanceWindow } from "../credits/allowance";
import { chargeThresholdCents, sweepCredits } from "../credits/payg";
import type { CreditLedger } from "../credits/ledger";
import { resolveEntitlements } from "../entitlements/resolve";
import type { BillingEntitlements } from "../entitlements/service";
import { BillingInputError, BillingNotFoundError, BillingStateError, BillingUnknownCustomerError, OfferClosedError } from "../errors";
import { CHECKOUT_HOLD_MS, type OfferSlots } from "../offers/founder";
import { BillingNotConfiguredError, NOT_TRIALING, ProviderRejectedError } from "../provider/errors";
import {
  CHECKOUT_ID_PLACEHOLDER,
  isLiveSubscriptionStatus,
  type BillingProvider,
  type CheckoutLink,
  type CustomerState,
  type InvoiceSummary,
  type PaymentMethodSummary,
  type PortalLink,
  type ProviderCustomerRef,
} from "../provider/provider";
import type { BillingStore } from "../store/store";
import type { BillingAccount, Page, SubscriptionRecord, SubscriptionStatus } from "../store/types";
import { NO_BILLING_LIFECYCLE_EVENTS, notifyLifecycle, subscriptionChanges, type BillingLifecycleEvents } from "../lifecycle-events";

export interface BillingPaymentEvents {
  /** `billing.plan_changed` (spec 9.4): the API rewrites the hosting tier of the account's sites. */
  planChanged?(event: { accountId: string; from: PlanKey; to: PlanKey }): void | Promise<void>;
  /** Counters of spec section 18. */
  count?(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void;
  /**
   * A state that needs an operator (spec 18): `billing.duplicate_subscription`
   * (the provider has two live subscriptions for one customer) and
   * `billing.founder_over_cap` (a founder price paid after the offer filled).
   */
  alert?(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void;
}

export interface BillingPaymentsDeps {
  readonly store: BillingStore;
  readonly catalog: Catalog;
  readonly clock: Clock;
  readonly provider: BillingProvider;
  readonly ledger: CreditLedger;
  readonly offers: OfferSlots;
  readonly entitlements: BillingEntitlements;
  /** `BILLING_DEFAULT_PLAN`. */
  readonly defaultPlan: PlanKey;
  /** `BillingConfig.returnBaseUrl`: an origin. */
  readonly returnBaseUrl: string;
  readonly events?: BillingPaymentEvents;
  /** Product analytics facts (`BillingLifecycleEvents`). Default: none. */
  readonly lifecycle?: BillingLifecycleEvents;
}

export interface SyncResult {
  readonly accountId: string;
  readonly from: PlanKey;
  readonly to: PlanKey;
  readonly changed: boolean;
}

const ENTITLED: readonly SubscriptionStatus[] = ["trialing", "active", "past_due"];
const ENDED: readonly SubscriptionStatus[] = ["canceled", "incomplete_expired", "unpaid"];
/** Statuses of a founder subscription whose first payment may still come: the lapsed hold keeps counting. */
const PAYMENT_PENDING: readonly SubscriptionStatus[] = ["trialing", "active", "incomplete"];
/** How long one request may take to create a Checkout before another request may (spec 14). */
export const CHECKOUT_CREATE_LEASE_MS = 2 * 60_000;
/** A lapsed founder hold whose payment is still coming is kept this much longer each cron run. */
export const PENDING_PAYMENT_HOLD_MS = 60 * 60_000;

type CheckoutSlot =
  | { readonly kind: "create" }
  | { readonly kind: "reuse"; readonly checkoutId: string }
  | { readonly kind: "replace"; readonly previousCheckoutId: string };

/**
 * The payments service (spec 12–14), written against the provider and store
 * ports. It never decides what an account can do: it copies provider state
 * into the store, and entitlements read the store.
 *
 * There is no "pay now" method: charges are automatic only (decision D19).
 */
export class BillingPayments {
  constructor(private readonly deps: BillingPaymentsDeps) {}

  get provider(): BillingProvider {
    return this.deps.provider;
  }

  private get lifecycle(): BillingLifecycleEvents {
    return this.deps.lifecycle ?? NO_BILLING_LIFECYCLE_EVENTS;
  }

  private now(): Date {
    return this.deps.clock.now();
  }

  private async account(accountId: string): Promise<BillingAccount> {
    const account = await this.deps.store.getAccount(accountId);
    if (!account) throw new BillingNotFoundError(`Billing account ${accountId} does not exist.`);
    return account;
  }

  private customerOf(account: BillingAccount): ProviderCustomerRef | null {
    return account.provider === this.deps.provider.name && account.providerCustomerId
      ? { provider: this.deps.provider.name, customerId: account.providerCustomerId }
      : null;
  }

  private billingPageUrl(accountId: string): string {
    return `${this.deps.returnBaseUrl}/dashboard/billing/${encodeURIComponent(accountId)}`;
  }

  /**
   * The success and cancel URLs of a Checkout. Without `returnPath`, the
   * billing page of the account. With one (a dashboard path, checked again
   * here: spec 17, no open redirect), that page on the dashboard origin; the
   * success URL adds `checkout={CHECKOUT_ID}` to its query.
   */
  private checkoutReturnUrls(accountId: string, returnPath: string | null | undefined): { successUrl: string; cancelUrl: string } {
    if (returnPath === null || returnPath === undefined) {
      const page = this.billingPageUrl(accountId);
      return { successUrl: `${page}?checkout=${CHECKOUT_ID_PLACEHOLDER}`, cancelUrl: page };
    }
    const problem = checkoutReturnPathProblem(returnPath, this.deps.returnBaseUrl);
    if (problem) throw new BillingInputError("invalid_return_path", problem);
    const url = new URL(returnPath, this.deps.returnBaseUrl);
    // The provider fills in the session ID; a stale one in the path is dropped.
    url.searchParams.delete("checkout");
    const cancelUrl = url.toString();
    const page = `${url.origin}${url.pathname}`;
    // The placeholder stays unencoded, so the provider can find and replace it.
    const query = url.search ? `${url.search}&` : "?";
    return { successUrl: `${page}${query}checkout=${CHECKOUT_ID_PLACEHOLDER}${url.hash}`, cancelUrl };
  }

  /** Creates or reuses the provider customer of the account and stores its ID. */
  async ensureCustomer(input: {
    accountId: string;
    email?: string | null;
    name?: string | null;
    /** The owner's Doxa user ID, for the provider's analytics join. */
    personDistinctId?: string | null;
  }): Promise<ProviderCustomerRef> {
    const account = await this.account(input.accountId);
    const existing = this.customerOf(account);
    const customer = await this.deps.provider.ensureCustomer({
      accountId: account.id,
      email: input.email ?? null,
      name: input.name ?? null,
      personDistinctId: input.personDistinctId ?? null,
      existing,
      idempotencyKey: `customer:${account.id}`,
    });
    if (!existing || existing.customerId !== customer.customerId) {
      await this.deps.store.withAccountLock(account.id, this.now(), (tx) =>
        tx.updateAccount({ provider: customer.provider, providerCustomerId: customer.customerId }),
      );
    }
    return customer;
  }

  /**
   * `POST /billing/accounts/:id/checkout` with `{ offer }`, a price key that
   * the customer saw. Throws `OfferClosedError` (409) when the founder offer
   * filled, with the new price, so the dashboard asks the customer first.
   */
  async createCheckout(input: {
    accountId: string;
    priceKey: string;
    requestId: string;
    email?: string | null;
    name?: string | null;
    /** The owner's Doxa user ID, stored on the provider customer for the analytics join. */
    personDistinctId?: string | null;
    /** The Doxa user who opens the Checkout, for `checkoutStarted`. */
    actorUserId?: string | null;
    /** A dashboard path to return to in place of the billing page (`BillingInputError` when it is not one). */
    returnPath?: string | null;
  }): Promise<CheckoutLink> {
    if (!this.deps.provider.capabilities.checkout) throw new BillingNotConfiguredError("checkout");
    const returnUrls = this.checkoutReturnUrls(input.accountId, input.returnPath);
    const price = this.deps.catalog.prices[input.priceKey];
    if (!price || !this.deps.catalog.plans[price.plan].selfServe || price.availableForNewCustomers === false) {
      throw new BillingInputError("unknown_offer", `"${input.priceKey}" is not an offer that a new customer can buy.`);
    }
    const usagePriceKey = price.usage;
    const account = await this.account(input.accountId);
    const subscription = await this.deps.store.getSubscription(account.id);
    if (subscription && isLiveSubscriptionStatus(subscription.status)) throw alreadySubscribed();

    // One Checkout for each account at a time: two tabs or a retry reuse it,
    // so the customer can never pay for two subscriptions.
    const slot = await this.claimCheckoutSlot(account.id, input.priceKey);
    if (slot.kind === "reuse") {
      const reused = await this.reusableCheckout(account.id, slot.checkoutId);
      if (reused) return reused;
      await this.takeOverCheckoutSlot(account.id, slot.checkoutId, input.priceKey);
    }
    if (slot.kind === "replace") {
      // The customer picked another price: the old Checkout must not stay payable.
      try {
        await this.deps.provider.expireCheckout(slot.previousCheckoutId);
      } catch (error) {
        await this.clearCheckoutSlot(account.id, null);
        throw error;
      }
    }

    const now = this.now();
    // Rounded up to a whole minute, and part of the idempotency key: a retry
    // with the same requestId in the same minute sends the same parameters, so
    // Stripe returns the first session instead of an idempotency error.
    const expiresAt = ceilToMinute(addMs(now, CHECKOUT_HOLD_MS));
    const offerKey = findOfferOfPrice(this.deps.catalog, input.priceKey);
    let releaseOnFailure = false;
    try {
      if (offerKey) {
        const before = await this.deps.store.getOfferSlot(offerKey, account.id);
        const hold = await this.deps.offers.hold({ offerKey, accountId: account.id, heldUntil: expiresAt });
        if (!hold.granted) throw new OfferClosedError(offerKey, hold.thenPrices[price.interval]);
        releaseOnFailure = before?.state !== "held" && before?.state !== "claimed";
      }
      const customer = await this.ensureCustomer({
        accountId: account.id,
        email: input.email ?? null,
        name: input.name ?? null,
        personDistinctId: input.personDistinctId ?? null,
      });
      // The provider's truth, not only the mirror: a subscription whose webhook
      // has not arrived yet (or any live status) refuses a second Checkout.
      const state = await this.deps.provider.fetchCustomerState(customer);
      if (state.liveSubscriptions.length > 0) throw alreadySubscribed();
      const plan = this.deps.catalog.plans[price.plan];
      // spec: the trial is for an account's first subscription only.
      const trialDays = plan.trial && !subscription && !state.subscription ? plan.trial.days : null;
      const link = await this.deps.provider.createCheckout({
        accountId: account.id,
        customer,
        priceKey: input.priceKey,
        usagePriceKey,
        trialDays,
        expiresAt,
        successUrl: returnUrls.successUrl,
        cancelUrl: returnUrls.cancelUrl,
        idempotencyKey: `checkout:${account.id}:${input.priceKey}:${input.requestId}:${expiresAt.getTime()}`,
      });
      await this.deps.store.withAccountLock(account.id, this.now(), (tx) =>
        tx.updateAccount({ openCheckout: { checkoutId: link.checkoutId, priceKey: input.priceKey, expiresAt: link.expiresAt } }),
      );
      if (offerKey) await this.deps.offers.attachCheckout({ offerKey, accountId: account.id, checkoutSessionId: link.checkoutId });
      notifyLifecycle(() =>
        this.lifecycle.checkoutStarted?.({
          accountId: account.id,
          priceKey: input.priceKey,
          interval: price.interval,
          trial: trialDays !== null,
          founder: offerKey !== null,
          actorUserId: input.actorUserId ?? null,
        }),
      );
      return link;
    } catch (error) {
      await this.clearCheckoutSlot(account.id, null);
      if (offerKey && releaseOnFailure) await this.deps.offers.release({ offerKey, accountId: account.id });
      throw error;
    }
  }

  /**
   * Under the account lock: reuse the account's open Checkout of the same
   * price, replace one of another price, or take a short lease to create one.
   * A second request while the first one creates its Checkout gets 409
   * `checkout_in_progress`; the dashboard asks the person to try again.
   */
  private claimCheckoutSlot(accountId: string, priceKey: string): Promise<CheckoutSlot> {
    const now = this.now();
    const lease = { checkoutId: null, priceKey, expiresAt: addMs(now, CHECKOUT_CREATE_LEASE_MS) };
    return this.deps.store.withAccountLock(accountId, now, async (tx): Promise<CheckoutSlot> => {
      const open = tx.account.openCheckout;
      if (open && open.expiresAt > now) {
        if (open.checkoutId === null) {
          throw new BillingStateError("checkout_in_progress", "A Checkout for this account is opening. Try again in a minute.");
        }
        if (open.priceKey === priceKey) return { kind: "reuse", checkoutId: open.checkoutId };
        await tx.updateAccount({ openCheckout: lease });
        return { kind: "replace", previousCheckoutId: open.checkoutId };
      }
      await tx.updateAccount({ openCheckout: lease });
      return { kind: "create" };
    });
  }

  /** The stored Checkout, when the provider says it is still open. */
  private async reusableCheckout(accountId: string, checkoutId: string): Promise<CheckoutLink | null> {
    const checkout = await this.deps.provider.fetchCheckout(checkoutId);
    if (checkout.status !== "open" || !checkout.url || (checkout.expiresAt && checkout.expiresAt <= this.now())) return null;
    if (checkout.accountId !== null && checkout.accountId !== accountId) return null;
    this.count("billing.checkout_reused", { accountId });
    return { checkoutId, url: checkout.url, expiresAt: checkout.expiresAt ?? addMs(this.now(), CHECKOUT_HOLD_MS) };
  }

  /** The stored Checkout was paid or expired: take the slot for a new one, unless another request did. */
  private async takeOverCheckoutSlot(accountId: string, staleCheckoutId: string, priceKey: string): Promise<void> {
    const now = this.now();
    await this.deps.store.withAccountLock(accountId, now, async (tx) => {
      const open = tx.account.openCheckout;
      if (open && open.expiresAt > now && open.checkoutId !== staleCheckoutId) {
        throw new BillingStateError("checkout_in_progress", "A Checkout for this account is opening. Try again in a minute.");
      }
      await tx.updateAccount({ openCheckout: { checkoutId: null, priceKey, expiresAt: addMs(now, CHECKOUT_CREATE_LEASE_MS) } });
    });
  }

  /** Drops this request's creation lease (`checkoutId` null), or the stored Checkout with that ID. */
  private async clearCheckoutSlot(accountId: string, checkoutId: string | null): Promise<void> {
    await this.deps.store.withAccountLock(accountId, this.now(), async (tx) => {
      if (tx.account.openCheckout?.checkoutId === checkoutId) await tx.updateAccount({ openCheckout: null });
    });
  }

  /** `POST /billing/accounts/:id/portal`. Founders get the founder configuration (spec 7.5 rule 5). */
  async createPortalSession(input: { accountId: string; flow?: "payment_method_update" | "subscription_cancel" | null }): Promise<PortalLink> {
    if (!this.deps.provider.capabilities.portal) throw new BillingNotConfiguredError("portal");
    const account = await this.account(input.accountId);
    const customer = this.customerOf(account);
    if (!customer) throw new BillingStateError("no_customer", "The account has no billing customer yet.");
    const subscription = await this.deps.store.getSubscription(account.id);
    const founder = subscription ? findOfferOfPrice(this.deps.catalog, subscription.priceKey) !== null : false;
    return this.deps.provider.createPortalSession({
      customer,
      returnUrl: this.billingPageUrl(account.id),
      configuration: founder ? "founder" : "standard",
      flow: input.flow ?? null,
    });
  }

  /**
   * `POST /billing/accounts/:id/plan-interval`: the monthly/yearly switch
   * (spec 13). The Customer Portal cannot update a subscription with a usage
   * price, so the dashboard calls this. A founder stays on the founder price of
   * the other interval. The webhook then syncs the new state.
   */
  async switchPlanInterval(input: { accountId: string; interval: "month" | "year"; requestId: string }): Promise<{ priceKey: string }> {
    const switchPrice = this.deps.provider.switchPlanPrice?.bind(this.deps.provider);
    if (!switchPrice) throw new BillingNotConfiguredError("plan_switch");
    const target = await this.planSwitchTarget(input.accountId, input.interval);
    if (target.priceKey === target.subscription.priceKey) return { priceKey: target.priceKey };
    await switchPrice({
      customer: target.customer,
      subscriptionId: target.subscription.providerSubscriptionId,
      priceKey: target.priceKey,
      idempotencyKey: `plan-interval:${input.accountId}:${target.priceKey}:${input.requestId}`,
    });
    return { priceKey: target.priceKey };
  }

  /**
   * `GET /billing/accounts/:id/plan-interval/preview`: what `switchPlanInterval`
   * charges now, from the provider's invoice preview of the same change.
   * The same interval answers 409 `same_interval`: there is nothing to preview.
   */
  async previewPlanInterval(input: { accountId: string; interval: "month" | "year" }): Promise<BillingPlanIntervalPreview> {
    const preview = this.deps.provider.previewPlanSwitch?.bind(this.deps.provider);
    if (!preview) throw new BillingNotConfiguredError("plan_switch");
    const target = await this.planSwitchTarget(input.accountId, input.interval);
    if (target.priceKey === target.subscription.priceKey) {
      throw new BillingStateError("same_interval", `The subscription is already billed every ${input.interval}.`);
    }
    const money = await preview({ customer: target.customer, subscriptionId: target.subscription.providerSubscriptionId, priceKey: target.priceKey });
    const price = this.deps.catalog.prices[target.priceKey];
    if (!price) throw new BillingStateError("unknown_price", "The new price is not in the catalog. Contact support.");
    return { ...money, newPriceCents: price.amountCents, newInterval: price.interval };
  }

  /** The subscription to switch and the price of the other interval (the current price when it is already that interval). */
  private async planSwitchTarget(
    accountId: string,
    interval: "month" | "year",
  ): Promise<{ customer: ProviderCustomerRef; subscription: SubscriptionRecord; priceKey: string }> {
    const account = await this.account(accountId);
    const customer = this.customerOf(account);
    const subscription = await this.deps.store.getSubscription(account.id);
    if (!customer || !subscription || !ENTITLED.includes(subscription.status)) {
      throw new BillingStateError("no_subscription", "The account has no active subscription to switch.");
    }
    const current = this.deps.catalog.prices[subscription.priceKey];
    if (!current) throw new BillingStateError("unknown_price", "The subscription price is not in the catalog. Contact support.");
    if (current.interval === interval) return { customer, subscription, priceKey: subscription.priceKey };
    const target = siblingPrice(this.deps.catalog, subscription.priceKey, interval);
    if (!target) throw new BillingStateError("no_price_for_interval", `No ${interval} price matches the current plan.`);
    return { customer, subscription, priceKey: target };
  }

  /**
   * `POST /billing/accounts/:id/start-pro-now` (decision D22): ends the trial
   * at once and charges the plan, then syncs the account, as the Checkout
   * return does. The monthly allowance starts with the new billing anchor and
   * the trial credits end (`CreditLedger`). A declined card changes nothing:
   * the provider throws `ProviderRejectedError` with `PAYMENT_FAILED`.
   */
  async startProNow(input: { accountId: string; requestId: string }): Promise<SyncResult> {
    const endTrial = this.deps.provider.endTrialNow?.bind(this.deps.provider);
    if (!endTrial) throw new BillingNotConfiguredError("start_pro_now");
    const { customer, subscription } = await this.trialingSubscription(input.accountId);
    try {
      await endTrial({
        customer,
        subscriptionId: subscription.providerSubscriptionId,
        idempotencyKey: `start-pro-now:${input.accountId}:${subscription.providerSubscriptionId}:${input.requestId}`,
      });
    } catch (error) {
      // The mirror said trialing, the provider says it is not: copy the provider's state, then refuse.
      if (error instanceof ProviderRejectedError && error.providerCode === NOT_TRIALING) {
        await this.syncCustomer(customer, input.accountId);
        throw notTrialing();
      }
      throw error;
    }
    this.count("billing.start_pro_now", { accountId: input.accountId });
    return this.syncCustomer(customer, input.accountId);
  }

  /** `GET /billing/accounts/:id/start-pro-now`: what Start Pro now charges, for the confirm dialog. */
  async previewStartProNow(accountId: string): Promise<BillingStartProNowPreview> {
    const preview = this.deps.provider.previewTrialEnd?.bind(this.deps.provider);
    if (!preview) throw new BillingNotConfiguredError("start_pro_now");
    const { customer, subscription } = await this.trialingSubscription(accountId);
    const price = this.deps.catalog.prices[subscription.priceKey];
    if (!price) throw new BillingStateError("unknown_price", "The subscription price is not in the catalog. Contact support.");
    const invoice = await preview({ customer, subscriptionId: subscription.providerSubscriptionId });
    return { amountCents: invoice.amountDueCents, currency: invoice.currency, intervalLabel: price.interval };
  }

  private async trialingSubscription(accountId: string): Promise<{ customer: ProviderCustomerRef; subscription: SubscriptionRecord }> {
    const account = await this.account(accountId);
    const customer = this.customerOf(account);
    const subscription = await this.deps.store.getSubscription(account.id);
    if (!customer || !subscription || subscription.status !== "trialing") throw notTrialing();
    return { customer, subscription };
  }

  /**
   * The card on file for the billing page: one provider call at most. Never
   * throws: without a provider method or a customer it is null, and a
   * provider failure is null plus a `billing.payment_method_unavailable` count.
   */
  async readPaymentMethod(accountId: string): Promise<PaymentMethodSummary | null> {
    const fetchCard = this.deps.provider.fetchPaymentMethod?.bind(this.deps.provider);
    if (!fetchCard) return null;
    try {
      const account = await this.account(accountId);
      const customer = this.customerOf(account);
      if (!customer) return null;
      const subscription = await this.deps.store.getSubscription(account.id);
      const subscriptionId = subscription && isLiveSubscriptionStatus(subscription.status) ? subscription.providerSubscriptionId : null;
      return await fetchCard({ customer, subscriptionId });
    } catch (error) {
      this.count("billing.payment_method_unavailable", {
        accountId,
        error: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : null,
      });
      return null;
    }
  }

  async listInvoices(input: { accountId: string; limit: number; cursor?: string | null }): Promise<Page<InvoiceSummary>> {
    const account = await this.account(input.accountId);
    const customer = this.customerOf(account);
    if (!customer || !this.deps.provider.capabilities.invoices) return { items: [], nextCursor: null };
    return this.deps.provider.listInvoices({ customer, limit: input.limit, cursor: input.cursor ?? null });
  }

  /**
   * Copies the provider's current truth into the subscription mirror and the
   * account plan (spec 14.1). Webhooks, the Checkout return and the sync job
   * all call it, so event order never matters. Also moves the founder slot
   * and sets the pay-as-you-go threshold of a new subscription.
   */
  async syncCustomer(customer: ProviderCustomerRef, accountIdHint: string | null = null): Promise<SyncResult> {
    const state = await this.deps.provider.fetchCustomerState(customer);
    const byCustomer = await this.deps.store.findAccountByProviderCustomer(customer.provider, customer.customerId);
    const accountId = byCustomer?.id ?? state.accountId ?? accountIdHint;
    if (!accountId) throw new BillingUnknownCustomerError(`No billing account for customer ${customer.customerId}.`);
    const now = this.now();
    if (state.liveSubscriptions.length > 1) {
      // Never cancelled here: an operator refunds and cancels the extra one.
      // The mirror keeps the oldest paid subscription (`countingSubscription`).
      this.alert("billing.duplicate_subscription", {
        accountId,
        customerId: customer.customerId,
        live: state.liveSubscriptions.length,
        mirrored: state.subscription?.subscriptionId ?? null,
        subscriptionIds: state.liveSubscriptions.map((sub) => sub.subscriptionId).join(","),
      });
    }

    const { from, to, newSubscription, changes } = await this.deps.store.withAccountLock(accountId, now, async (tx) => {
      const previous = await tx.getSubscription();
      const next = mirrorOf(accountId, customer, state, previous, now);
      if (next) await tx.upsertSubscription(next);
      if (!tx.account.providerCustomerId) await tx.updateAccount({ provider: customer.provider, providerCustomerId: customer.customerId });
      const overrides = await this.deps.store.listOverrides(accountId);
      const entitlements = resolveEntitlements({
        catalog: this.deps.catalog,
        defaultPlan: this.deps.defaultPlan,
        subscription: next ?? previous,
        overrides,
        now,
      });
      const fromPlan = tx.account.planKey;
      if (fromPlan !== entitlements.plan) await tx.updateAccount({ planKey: entitlements.plan });
      return {
        from: fromPlan,
        to: entitlements.plan,
        newSubscription: next !== null && next.providerSubscriptionId !== previous?.providerSubscriptionId ? next : null,
        // Under the lock, so two syncs at the same moment see each change once.
        changes: subscriptionChanges({ catalog: this.deps.catalog, previous, next, now }),
      };
    });

    await this.moveFounderSlot(accountId, state);
    if (newSubscription && this.deps.provider.setChargeThreshold && this.deps.provider.capabilities.usageReporting) {
      await this.deps.provider.setChargeThreshold({
        customer,
        subscriptionId: newSubscription.providerSubscriptionId,
        amountCents: chargeThresholdCents(this.deps.catalog),
      });
    }
    if (from !== to) await this.deps.events?.planChanged?.({ accountId, from, to });
    for (const change of changes) notifyLifecycle(() => this.lifecycle.subscriptionChanged?.(change));
    this.count("billing.sync", { accountId, changed: from !== to });
    return { accountId, from, to, changed: from !== to };
  }

  /** `POST /billing/checkout/:sessionId/sync`: the same path as the webhook, so the user sees Pro at once. */
  async syncCheckout(checkoutId: string): Promise<SyncResult | null> {
    const checkout = await this.deps.provider.fetchCheckout(checkoutId);
    if (!checkout.customer) return null;
    return this.syncCustomer(checkout.customer, checkout.accountId);
  }

  /**
   * Sends usage reports that the provider has not accepted yet (spec 10.10
   * step 2). The provider refuses a repeated identifier, so a retry never
   * charges twice.
   */
  async reportPendingUsage(limit = 100): Promise<{ sent: number; failed: number }> {
    const report = this.deps.provider.reportUsage?.bind(this.deps.provider);
    if (!report || !this.deps.provider.capabilities.usageReporting) return { sent: 0, failed: 0 };
    let sent = 0;
    let failed = 0;
    for (const row of await this.deps.store.listPendingUsageReports(limit)) {
      const account = await this.deps.store.getAccount(row.accountId);
      const customer = account ? this.customerOf(account) : null;
      if (!customer) {
        failed += 1;
        await this.deps.store.markUsageReportFailed(row.identifier, this.now());
        continue;
      }
      try {
        await report({ customer, identifier: row.identifier, credits: row.credits, occurredAt: row.createdAt });
        await this.deps.store.markUsageReportSent(row.identifier, this.now());
        sent += 1;
      } catch {
        failed += 1;
        await this.deps.store.markUsageReportFailed(row.identifier, this.now());
      }
    }
    this.count("payg.report", { sent, failed });
    return { sent, failed };
  }

  /**
   * The monthly sweep (spec 10.10 step 6). When the unbilled debt is at least
   * `sweepMinCredits`, lowers the threshold to it, then sends usage so the
   * provider checks the threshold: the pending reports, or a 1-credit debt.
   */
  async runMonthlySweep(accountId: string): Promise<{ sweptCredits: number; ran: boolean }> {
    const setThreshold = this.deps.provider.setChargeThreshold?.bind(this.deps.provider);
    if (!setThreshold || !this.deps.provider.capabilities.usageReporting) return { sweptCredits: 0, ran: false };
    const view = await this.deps.entitlements.forAccount(accountId);
    const customer = this.customerOf(view.account);
    if (!customer || !view.subscription) return { sweptCredits: 0, ran: false };
    // Once for each allowance window, and late rather than never: the job
    // sweeps any window after the last swept one (a missed tick catches up).
    const window = allowanceWindow(view.subscription.billingAnchor, this.now());
    const swept = view.account.paygSweptWindowStart;
    if (swept !== null && swept.getTime() >= window.start.getTime()) return { sweptCredits: 0, ran: false };
    const result = await this.sweepUnbilled(accountId, view, customer, setThreshold);
    await this.deps.store.withAccountLock(accountId, this.now(), async (tx) => {
      const current = tx.account.paygSweptWindowStart;
      if (current === null || current.getTime() < window.start.getTime()) await tx.updateAccount({ paygSweptWindowStart: window.start });
    });
    return { ...result, ran: true };
  }

  private async sweepUnbilled(
    accountId: string,
    view: Awaited<ReturnType<BillingEntitlements["forAccount"]>>,
    customer: ProviderCustomerRef,
    setThreshold: NonNullable<BillingProvider["setChargeThreshold"]>,
  ): Promise<{ sweptCredits: number }> {
    if (!view.subscription) return { sweptCredits: 0 };
    const balance = await this.deps.ledger.balance(accountId, view.creditContext);
    const invoices = await this.deps.store.listPaygInvoices(accountId);
    const invoicedUnpaid = invoices.filter((row) => row.status === "draft" || row.status === "open" || row.status === "failed").reduce((sum, row) => sum + row.credits, 0);
    const unbilled = Math.max(0, balance.openDebt - invoicedUnpaid);
    const swept = sweepCredits(this.deps.catalog, unbilled);
    if (swept === 0) return { sweptCredits: 0 };
    const pending = (await this.deps.store.listPendingUsageReports(10_000)).filter((row) => row.accountId === accountId);
    const pendingCredits = pending.reduce((sum, row) => sum + row.credits, 0);
    const reportedUnbilled = Math.max(0, unbilled - pendingCredits);
    const unit = this.deps.catalog.credit.unitPriceCents;
    await setThreshold({
      customer,
      subscriptionId: view.subscription.providerSubscriptionId,
      amountCents: Math.max(this.deps.catalog.payg.sweepMinCredits, reportedUnbilled) * unit,
    });
    if (pending.length === 0) {
      await this.deps.ledger.addDebt({
        accountId,
        credits: 1,
        identifier: `sweep:${accountId}:${balance.windowStart.toISOString()}`,
        metadata: { reason: "sweep" },
      });
    }
    await this.reportPendingUsage();
    this.count("payg.sweep", { accountId, credits: swept });
    return { sweptCredits: swept };
  }

  /** The hourly sync job (spec 14.3): accounts whose subscription may change without a webhook we saw. */
  async syncOpenSubscriptions(): Promise<number> {
    const ids = await this.deps.store.listAccountIdsBySubscriptionStatus(["past_due", "incomplete", "trialing"]);
    let synced = 0;
    for (const id of ids) {
      const account = await this.deps.store.getAccount(id);
      const customer = account ? this.customerOf(account) : null;
      if (!customer) continue;
      await this.syncCustomer(customer, id);
      synced += 1;
    }
    return synced;
  }

  private async moveFounderSlot(accountId: string, state: CustomerState): Promise<void> {
    const subscription = state.subscription;
    if (!subscription) return;
    const offerKey = findOfferOfPrice(this.deps.catalog, subscription.priceKey);
    if (!offerKey) return;
    if (state.firstPaidInvoiceAt) {
      const claim = await this.deps.offers.claim({ offerKey, accountId });
      if (claim.overCap) this.alert("billing.founder_over_cap", { accountId, offerKey, priceKey: subscription.priceKey });
      return;
    }
    if (subscription.status === "trialing" && subscription.trialEnd) {
      await this.deps.offers.holdThroughTrial({ offerKey, accountId, trialEnd: subscription.trialEnd });
      return;
    }
    if (ENDED.includes(subscription.status)) await this.deps.offers.release({ offerKey, accountId });
  }

  /**
   * The 5-minute cron (spec 7.5 rule 7): releases founder holds that lapsed,
   * except a hold whose payment is still coming (a completed Checkout whose
   * webhook is late, for example during the nightly ECS pause, or a trial
   * whose first invoice is not paid yet). Those are synced and kept another
   * hour, so they keep counting and the offer never sells more than its slots.
   */
  async releaseExpiredHolds(): Promise<{ released: number; kept: number }> {
    let released = 0;
    let kept = 0;
    for (const slot of await this.deps.offers.listExpiredHolds()) {
      if (await this.founderPaymentPending(slot.offerKey, slot.accountId, slot.checkoutSessionId)) {
        await this.deps.offers.extendHold({ offerKey: slot.offerKey, accountId: slot.accountId, heldUntil: addMs(this.now(), PENDING_PAYMENT_HOLD_MS) });
        kept += 1;
        continue;
      }
      await this.deps.offers.release({ offerKey: slot.offerKey, accountId: slot.accountId });
      released += 1;
    }
    return { released, kept };
  }

  private async founderPaymentPending(offerKey: string, accountId: string, checkoutSessionId: string | null): Promise<boolean> {
    const account = await this.deps.store.getAccount(accountId);
    const customer = account ? this.customerOf(account) : null;
    if (checkoutSessionId) {
      let status: "open" | "complete" | "expired";
      try {
        status = (await this.deps.provider.fetchCheckout(checkoutSessionId)).status;
      } catch {
        return true; // unknown: keep it and ask again next run
      }
      if (status === "open") return true;
      if (status === "complete" && customer) await this.syncCustomer(customer, accountId);
    }
    const subscription = await this.deps.store.getSubscription(accountId);
    const offer = this.deps.catalog.offers[offerKey];
    const onOffer = subscription !== null && offer !== undefined && Object.values(offer.prices).includes(subscription.priceKey);
    return onOffer && PAYMENT_PENDING.includes(subscription.status);
  }

  private count(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void {
    this.deps.events?.count?.(name, fields);
  }

  private alert(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void {
    if (this.deps.events?.alert) this.deps.events.alert(name, fields);
    else this.count(name, fields);
  }
}

function mirrorOf(
  accountId: string,
  customer: ProviderCustomerRef,
  state: CustomerState,
  previous: SubscriptionRecord | null,
  now: Date,
): SubscriptionRecord | null {
  const sub = state.subscription;
  if (!sub) {
    // The provider has no subscription any more: keep the row as ended.
    return previous && previous.status !== "canceled" ? { ...previous, status: "canceled", syncedAt: now } : null;
  }
  return {
    accountId,
    provider: customer.provider,
    providerSubscriptionId: sub.subscriptionId,
    priceKey: sub.priceKey,
    planKey: sub.planKey,
    status: sub.status,
    billingAnchor: sub.billingAnchor,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    trialEnd: sub.trialEnd,
    pastDueSince:
      sub.status === "past_due"
        ? (sub.pastDueSince ?? (previous?.status === "past_due" ? previous.pastDueSince : null) ?? now)
        : null,
    syncedAt: now,
  };
}

function notTrialing(): BillingStateError {
  return new BillingStateError("not_trialing", "The subscription is not in its trial.");
}

function alreadySubscribed(): BillingStateError {
  return new BillingStateError("already_subscribed", "The account already has a subscription. Use the Customer Portal to change it.");
}

function ceilToMinute(date: Date): Date {
  const minute = 60_000;
  return new Date(Math.ceil(date.getTime() / minute) * minute);
}

/** The price of the same plan and offer for another interval (founder stays founder). */
function siblingPrice(catalog: Catalog, priceKey: string, interval: "month" | "year"): string | null {
  for (const offer of Object.values(catalog.offers)) {
    if (Object.values(offer.prices).includes(priceKey)) return offer.prices[interval] ?? null;
    if (Object.values(offer.then).includes(priceKey)) return offer.then[interval] ?? null;
  }
  const current = catalog.prices[priceKey];
  if (!current) return null;
  for (const [key, price] of Object.entries(catalog.prices)) {
    if (price.plan === current.plan && price.interval === interval && price.availableForNewCustomers !== false) return key;
  }
  return null;
}
