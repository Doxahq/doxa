import type { PlanKey } from "../../catalog/keys";
import type { PortalConfiguration } from "../../provider/provider";

/**
 * Names that Doxa chooses for its Stripe objects. None of them is an
 * account-issued ID: products use Doxa's own custom IDs, prices use the
 * catalog key as `lookup_key`, the meter uses its `event_name`, and the Portal
 * configurations carry a metadata tag. So the repo stores no Stripe ID.
 */
export const STRIPE_PROVIDER = "stripe" as const;

/** Every Doxa object carries this metadata, so the sync never touches objects it did not make. */
export const META_MANAGED = "doxa_managed";
export const META_ACCOUNT = "doxa_billing_account_id";
/** The account owner's Doxa user ID on the customer: PostHog joins Stripe revenue to that person. */
export const META_POSTHOG_PERSON = "posthog_person_distinct_id";
export const META_PRICE_KEY = "doxa_price_key";
export const META_PLAN = "doxa_plan";
export const META_OFFER = "doxa_offer";
export const META_PORTAL = "doxa_portal";
export const META_CONFIG_HASH = "doxa_config_hash";

/** The product of a plan's prices. A custom product ID, so the sync finds it without a search. */
export function planProductId(plan: PlanKey): string {
  return `doxa_${plan}`;
}

/** The product of every usage price. Invoice lines on it are pay-as-you-go credits. */
export const USAGE_PRODUCT_ID = "doxa_ai_usage";

/**
 * Stripe Tax product tax codes (spec 7.3): `txcd_10103001` SaaS for business
 * use (the plan), `txcd_10105002` for the AI usage. Managed Payments needs them.
 */
export const PLAN_TAX_CODE = "txcd_10103001";
export const USAGE_TAX_CODE = "txcd_10105002";

/** The meter payload keys (spec 13: sum of `value`, customer by `stripe_customer_id`). */
export const METER_CUSTOMER_KEY = "stripe_customer_id";
export const METER_VALUE_KEY = "value";

export const PORTAL_CONFIGURATIONS = ["founder", "standard"] as const satisfies readonly PortalConfiguration[];

/** Webhook events to subscribe on the endpoint (spec 14.1). `listEventsSince` reads the same list. */
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.created",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
] as const;

/** The webhook signature tolerance (spec 14.1 and 17). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** Stripe refuses a Checkout Session that expires sooner than 30 minutes from its own clock. */
export const CHECKOUT_MIN_LIFETIME_MS = 31 * 60_000;

/** Stripe accepts meter events up to 35 days old. */
export const METER_EVENT_MAX_AGE_MS = 34 * 24 * 60 * 60_000;
