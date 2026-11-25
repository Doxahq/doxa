import type { Catalog } from "./catalog/define";
import { findOfferOfPrice } from "./catalog/display";
import type { BillingInterval } from "./catalog/keys";
import { DAY_MS } from "./clock";
import type { SubscriptionRecord, SubscriptionStatus } from "./store/types";

/** The account's subscription after a change, so a listener can describe the account. */
export interface AccountSubscriptionSnapshot {
  readonly accountId: string;
  readonly planKey: string;
  readonly priceKey: string;
  readonly status: SubscriptionStatus;
  readonly interval: BillingInterval;
  readonly founder: boolean;
}

/** One move of the subscription mirror, found by comparing the mirror before and after a sync. */
export type SubscriptionLifecycleChange =
  | { readonly kind: "trial_started"; readonly subscription: AccountSubscriptionSnapshot }
  | { readonly kind: "trial_converted"; readonly subscription: AccountSubscriptionSnapshot; readonly daysInTrial: number }
  | { readonly kind: "subscription_started"; readonly subscription: AccountSubscriptionSnapshot }
  | { readonly kind: "past_due"; readonly subscription: AccountSubscriptionSnapshot; readonly daysOverdue: number }
  | { readonly kind: "canceled"; readonly subscription: AccountSubscriptionSnapshot; readonly wasTrial: boolean }
  | {
      readonly kind: "interval_changed";
      readonly subscription: AccountSubscriptionSnapshot;
      readonly from: BillingInterval;
      readonly to: BillingInterval;
    };

/**
 * Facts of the customer's billing life, for product analytics. The package
 * never imports an analytics SDK: the API injects a listener, as it injects
 * `MeterEvents`. Each method runs after the work is stored, and a listener
 * that throws never changes that work.
 */
export interface BillingLifecycleEvents {
  /** A new Checkout Session was created (not a reused one). */
  checkoutStarted?(event: {
    readonly accountId: string;
    readonly priceKey: string;
    readonly interval: BillingInterval;
    readonly trial: boolean;
    readonly founder: boolean;
    /** The Doxa user who opened the Checkout, when the caller names one. */
    readonly actorUserId: string | null;
  }): void;
  checkoutCompleted?(event: { readonly accountId: string; readonly priceKey: string | null; readonly interval: BillingInterval | null }): void;
  checkoutExpired?(event: { readonly accountId: string }): void;
  subscriptionChanged?(change: SubscriptionLifecycleChange): void;
  /** A plan or pay-as-you-go invoice was paid or failed, once for each invoice and outcome. */
  invoiceSettled?(event: {
    readonly accountId: string;
    readonly outcome: "paid" | "failed";
    readonly kind: "plan" | "usage";
    readonly amountCents: number;
    readonly attempt: number | null;
  }): void;
}

export const NO_BILLING_LIFECYCLE_EVENTS: BillingLifecycleEvents = {};

const ENDED: readonly SubscriptionStatus[] = ["canceled", "incomplete_expired", "unpaid"];

/** The plan, interval and founder flag of a catalog price, or null for a price outside the catalog (Enterprise). */
export function priceFacts(catalog: Catalog, priceKey: string): { planKey: string; interval: BillingInterval; founder: boolean } | null {
  const price = catalog.prices[priceKey];
  return price ? { planKey: price.plan, interval: price.interval, founder: findOfferOfPrice(catalog, priceKey) !== null } : null;
}

/**
 * The lifecycle changes between two states of the mirror. A sync that
 * changes nothing returns none, so a replayed webhook or the hourly sync
 * never counts a change twice. A price outside the catalog returns none.
 */
export function subscriptionChanges(input: {
  readonly catalog: Catalog;
  readonly previous: SubscriptionRecord | null;
  readonly next: SubscriptionRecord | null;
  readonly now: Date;
}): SubscriptionLifecycleChange[] {
  const { previous, next, now } = input;
  if (!next) return [];
  const facts = priceFacts(input.catalog, next.priceKey);
  if (!facts) return [];
  const subscription: AccountSubscriptionSnapshot = {
    accountId: next.accountId,
    priceKey: next.priceKey,
    status: next.status,
    ...facts,
  };
  const same = previous !== null && previous.providerSubscriptionId === next.providerSubscriptionId;
  const before = same ? previous.status : null;
  if (before === next.status) return intervalChange(input.catalog, same ? previous : null, subscription);

  if (next.status === "trialing" && before === null) return [{ kind: "trial_started", subscription }];
  if (next.status === "active" && before === "trialing") {
    return [{ kind: "trial_converted", subscription, daysInTrial: wholeDays(previous?.currentPeriodStart ?? now, now) }];
  }
  if (next.status === "active" && (before === null || before === "incomplete")) return [{ kind: "subscription_started", subscription }];
  if (next.status === "past_due") return [{ kind: "past_due", subscription, daysOverdue: wholeDays(next.pastDueSince ?? now, now) }];
  if (ENDED.includes(next.status) && before !== null && !ENDED.includes(before)) {
    return [{ kind: "canceled", subscription, wasTrial: before === "trialing" }];
  }
  return [];
}

function intervalChange(
  catalog: Catalog,
  previous: SubscriptionRecord | null,
  subscription: AccountSubscriptionSnapshot,
): SubscriptionLifecycleChange[] {
  const from = previous ? priceFacts(catalog, previous.priceKey)?.interval : undefined;
  if (!from || from === subscription.interval) return [];
  return [{ kind: "interval_changed", subscription, from, to: subscription.interval }];
}

function wholeDays(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

/** Calls one listener method; a listener that throws never reaches billing. */
export function notifyLifecycle(run: () => void): void {
  try {
    run();
  } catch {
    // Analytics never changes the billing work that it reports on.
  }
}
