import type { AnalyticsGroupProperties, ProductAnalytics, ProductEvent, ServerEventName } from "@doxahq/analytics";
import type { AccountSubscriptionSnapshot, BillingLifecycleEvents, SubscriptionLifecycleChange } from "@doxahq/billing";

/** A server event without its person and groups: the adapter adds them. */
type BillingEventBody = { [Name in ServerEventName]: Omit<ProductEvent<Name>, "distinctId" | "groups"> }[ServerEventName];

export interface BillingAnalyticsDeps {
  readonly analytics: () => ProductAnalytics;
  /** The Doxa user ID of the account owner, or null when the owner is gone. */
  readonly ownerUserId: (accountId: string) => Promise<string | null>;
}

/**
 * The billing lifecycle (`@doxahq/billing`) as product analytics events. A
 * webhook has no signed-in user, so its events count for the account owner;
 * a Checkout counts for the user who opened it. Every event belongs to the
 * `account` group, and a subscription change also describes that group.
 */
export function billingLifecycleAnalytics(deps: BillingAnalyticsDeps): BillingLifecycleEvents {
  // The owner lookup runs in the background: the webhook answers without
  // waiting for analytics, and without analytics there is no lookup at all.
  const send = (accountId: string, actorUserId: string | null, body: BillingEventBody): void => {
    deps.analytics().captureWhenReady(async () => {
      const distinctId = actorUserId ?? (await deps.ownerUserId(accountId));
      return distinctId ? [{ ...body, distinctId, groups: { account: accountId } }] : [];
    });
  };

  return {
    checkoutStarted: (event) =>
      send(event.accountId, event.actorUserId, {
        name: "checkout_started",
        properties: { plan_key: event.priceKey, interval: event.interval, trial: event.trial, founder: event.founder },
      }),
    checkoutCompleted: (event) =>
      send(event.accountId, null, {
        name: "checkout_completed",
        properties: { ...(event.priceKey ? { plan_key: event.priceKey } : {}), ...(event.interval ? { interval: event.interval } : {}) },
      }),
    checkoutExpired: (event) => send(event.accountId, null, { name: "checkout_expired", properties: {} }),
    subscriptionChanged: (change) => {
      deps.analytics().describeGroup({ type: "account", key: change.subscription.accountId, properties: accountProperties(change.subscription) });
      send(change.subscription.accountId, null, subscriptionEvent(change));
    },
    invoiceSettled: (event) =>
      send(event.accountId, null, {
        name: event.outcome === "paid" ? "invoice_paid" : "invoice_payment_failed",
        properties: { kind: event.kind, amount_cents: event.amountCents, ...(event.attempt === null ? {} : { attempt: event.attempt }) },
      }),
  };
}

function accountProperties(subscription: AccountSubscriptionSnapshot): AnalyticsGroupProperties<"account"> {
  return {
    plan: subscription.planKey,
    subscription_status: subscription.status,
    interval: subscription.interval,
    founder: subscription.founder,
  };
}

/** `plan_key` is the catalog price key, such as `pro_monthly_v1`: it names the exact offer. */
function subscriptionEvent(change: SubscriptionLifecycleChange): BillingEventBody {
  const { priceKey, interval, founder } = change.subscription;
  switch (change.kind) {
    case "trial_started":
      return { name: "trial_started", properties: { plan_key: priceKey, interval, founder } };
    case "trial_converted":
      return { name: "trial_converted", properties: { plan_key: priceKey, interval, days_in_trial: change.daysInTrial } };
    case "subscription_started":
      return { name: "subscription_started", properties: { plan_key: priceKey, interval, founder } };
    case "past_due":
      return { name: "subscription_past_due", properties: { days_overdue: change.daysOverdue } };
    case "canceled":
      return { name: "subscription_canceled", properties: { was_trial: change.wasTrial } };
    case "interval_changed":
      return { name: "subscription_interval_changed", properties: { from: change.from, to: change.to } };
  }
}
