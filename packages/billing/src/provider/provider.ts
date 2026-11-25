import type { Catalog } from "../catalog/define";
import type { PlanKey } from "../catalog/keys";
import type { Page, SubscriptionStatus } from "../store/types";

/**
 * The payment provider port (spec section 12). The provider only moves
 * money: customers, Checkout, subscriptions, invoices, tax and refunds. Doxa
 * keeps plans, entitlements, credits and usage in its own database.
 *
 * Rules for every implementation:
 * - Never take an amount or a provider price ID from a caller. Prices are
 *   catalog keys; the provider finds its own objects by lookup key.
 * - Use `idempotencyKey` on every create call.
 * - Throw only `ProviderUnavailableError` (retry), `ProviderRejectedError`
 *   (do not retry) and, from `parseWebhook`, `ProviderSignatureError`.
 * - Pass `describeBillingProviderContract()` from `@doxahq/billing/testing`.
 */
export type BillingProviderName = "stripe" | "none" | "memory";

export interface ProviderCapabilities {
  readonly checkout: boolean;
  readonly portal: boolean;
  readonly invoices: boolean;
  readonly refunds: boolean;
  readonly usageReporting: boolean;
}

export interface ProviderCustomerRef {
  readonly provider: BillingProviderName;
  readonly customerId: string;
}

/** The email and name that a provider customer holds. */
export interface CustomerContact {
  readonly email: string | null;
  readonly name: string | null;
}

/**
 * The contact fields to update on an existing customer: each value that the
 * input gives and that differs. Null when nothing changes.
 */
export function contactChanges(current: CustomerContact, wanted: CustomerContact): Partial<{ email: string; name: string }> | null {
  const changes: { email?: string; name?: string } = {};
  if (wanted.email && wanted.email !== current.email) changes.email = wanted.email;
  if (wanted.name && wanted.name !== current.name) changes.name = wanted.name;
  return Object.keys(changes).length > 0 ? changes : null;
}

export interface EnsureCustomerInput {
  /** Stored as `metadata.doxa_billing_account_id`. One customer for each billing account. */
  readonly accountId: string;
  readonly email: string | null;
  readonly name: string | null;
  /**
   * Stored as `metadata.posthog_person_distinct_id`: the Doxa user ID of the
   * account owner, so product analytics can join revenue to that person.
   * Null or absent leaves the stored value as it is.
   */
  readonly personDistinctId?: string | null;
  /** An existing customer to reuse, when the account has one. */
  readonly existing: ProviderCustomerRef | null;
  readonly idempotencyKey: string;
}

export interface CreateCheckoutInput {
  readonly accountId: string;
  readonly customer: ProviderCustomerRef;
  /** A catalog price key, never an amount or a provider price ID. */
  readonly priceKey: string;
  /** The usage price of the same interval (spec 10.10). */
  readonly usagePriceKey: string;
  /** Null for no trial. */
  readonly trialDays: number | null;
  /** The Checkout Session lifetime: the founder hold ends with it. */
  readonly expiresAt: Date;
  /**
   * The return URL. `{CHECKOUT_ID}` is replaced by the provider's own
   * placeholder (Stripe: `{CHECKOUT_SESSION_ID}`).
   */
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** `checkout:<accountId>:<priceKey>:<requestId>`. */
  readonly idempotencyKey: string;
}

export const CHECKOUT_ID_PLACEHOLDER = "{CHECKOUT_ID}";

export interface CheckoutLink {
  readonly checkoutId: string;
  readonly url: string;
  readonly expiresAt: Date;
}

/** The two Customer Portal configurations of spec 7.5 rule 5. */
export type PortalConfiguration = "founder" | "standard";

export interface CreatePortalInput {
  readonly customer: ProviderCustomerRef;
  readonly returnUrl: string;
  readonly configuration: PortalConfiguration;
  readonly flow: "payment_method_update" | "subscription_cancel" | null;
}

export interface PortalLink {
  readonly url: string;
}

export interface ListInvoicesInput {
  readonly customer: ProviderCustomerRef;
  readonly limit: number;
  readonly cursor: string | null;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";
export type InvoiceReason = "subscription_create" | "subscription_cycle" | "subscription_update" | "threshold" | "final" | "manual" | "other";

export interface InvoiceSummary {
  readonly invoiceId: string;
  readonly status: InvoiceStatus;
  readonly reason: InvoiceReason;
  readonly amountDueCents: number;
  readonly amountPaidCents: number;
  readonly currency: "usd";
  /** Credits on the usage price lines of the invoice. */
  readonly usageCredits: number;
  readonly createdAt: Date;
  readonly hostedInvoiceUrl: string | null;
  readonly pdfUrl: string | null;
}

export interface ProviderSubscription {
  readonly subscriptionId: string;
  /** The catalog key of the plan price (the provider lookup key). */
  readonly priceKey: string;
  readonly usagePriceKey: string | null;
  /** The plan the provider names, for a price outside the catalog (Enterprise). */
  readonly planKey: PlanKey | null;
  readonly status: SubscriptionStatus;
  readonly billingAnchor: Date;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
  readonly trialEnd: Date | null;
  /** When the subscription entered `past_due`, if the provider knows it. */
  readonly pastDueSince: Date | null;
}

/** The current truth for one customer. Webhooks, the Checkout return and the sync job all use it. */
export interface CustomerState {
  readonly customer: ProviderCustomerRef;
  /** `metadata.doxa_billing_account_id`. */
  readonly accountId: string | null;
  /**
   * The subscription that counts, or null. With one live subscription, that
   * one. With several (a duplicate, see `liveSubscriptions`), the oldest paid
   * one (else the oldest). With none, the newest ended one.
   */
  readonly subscription: ProviderSubscription | null;
  /**
   * Every subscription of the customer that is not ended (`active`,
   * `trialing`, `past_due`, `unpaid`, `paused`, `incomplete`), oldest first.
   * Checkout refuses a customer with any; more than one is a duplicate that
   * an operator resolves (`billing.duplicate_subscription`).
   */
  readonly liveSubscriptions: readonly ProviderSubscription[];
  /** The first paid invoice with an amount above 0. Claims a founder slot (spec 7.5). */
  readonly firstPaidInvoiceAt: Date | null;
}

export interface CheckoutResult {
  readonly checkoutId: string;
  readonly accountId: string | null;
  readonly customer: ProviderCustomerRef | null;
  readonly status: "open" | "complete" | "expired";
  readonly priceKey: string | null;
  /** The hosted page while the Checkout is open, else null. */
  readonly url: string | null;
  readonly expiresAt: Date | null;
}

export interface RawWebhook {
  /** The raw body, unchanged. A signature check needs the exact bytes. */
  readonly body: string;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface UsageInvoiceRef {
  readonly invoiceId: string;
  readonly customer: ProviderCustomerRef;
  readonly credits: number;
  readonly amountCents: number;
  readonly reason: "threshold" | "renewal" | "final" | "other";
  readonly hostedInvoiceUrl: string | null;
}

/** A paid or failed invoice of the plan price (no usage lines), for the lifecycle events. */
export interface PlanInvoiceRef {
  readonly invoiceId: string;
  readonly outcome: "paid" | "failed";
  /** The amount paid, or the amount due for a failed payment. */
  readonly amountCents: number;
  /** The provider's payment attempt count, when it gives one. */
  readonly attempt: number | null;
}

interface EventBase {
  /** The provider event ID, unique for each provider. */
  readonly id: string;
  /** The provider's own event type, for logs. */
  readonly providerType: string;
  readonly occurredAt: Date;
}

/**
 * Normalized events. Subscription changes come only as `customer.changed`
 * plus a fresh `fetchCustomerState`, so event order never matters.
 *
 * spec: `checkout.expired` is not in the section 12 list; the founder hold
 * needs it (`checkout.session.expired` releases the slot, spec 7.5).
 */
export type ProviderEvent =
  | (EventBase & {
      readonly type: "customer.changed";
      readonly customer: ProviderCustomerRef;
      /** Set when a plan invoice was paid or failed: the change is that payment. */
      readonly invoice?: PlanInvoiceRef;
    })
  | (EventBase & {
      readonly type: "checkout.completed";
      readonly checkoutId: string;
      readonly customer: ProviderCustomerRef | null;
      readonly accountId: string | null;
    })
  | (EventBase & {
      readonly type: "checkout.expired";
      readonly checkoutId: string;
      /** `client_reference_id` of the Checkout, when the provider has it. */
      readonly accountId?: string | null;
    })
  | (EventBase & { readonly type: "usage_invoice.created"; readonly invoice: UsageInvoiceRef })
  | (EventBase & { readonly type: "usage_invoice.paid"; readonly invoice: UsageInvoiceRef })
  | (EventBase & { readonly type: "usage_invoice.failed"; readonly invoice: UsageInvoiceRef })
  | (EventBase & {
      readonly type: "payment.refunded";
      readonly customer: ProviderCustomerRef;
      readonly invoiceId: string | null;
      readonly amountCents: number;
      /** Credits of the refunded usage, 0 for a subscription invoice. */
      readonly usageCredits: number;
    })
  | (EventBase & { readonly type: "payment.disputed"; readonly customer: ProviderCustomerRef; readonly invoiceId: string | null })
  | (EventBase & { readonly type: "ignored" });

export type ProviderEventType = ProviderEvent["type"];

export interface UsageReport {
  readonly customer: ProviderCustomerRef;
  /** `job:<id>:settle`. The provider refuses a second event with the same identifier. */
  readonly identifier: string;
  readonly credits: number;
  readonly occurredAt: Date;
}

export interface ChargeThresholdInput {
  readonly customer: ProviderCustomerRef;
  readonly subscriptionId: string;
  readonly amountCents: number;
}

export type CatalogSyncActionKind =
  | "create_product"
  | "create_price"
  | "keep_price"
  | "archive_price"
  | "create_meter"
  | "update_portal"
  | "set_tax_code";

export interface CatalogSyncAction {
  readonly kind: CatalogSyncActionKind;
  /** A catalog key, a product key or a portal configuration name. */
  readonly key: string;
  /** One line for the printed plan. */
  readonly description: string;
}

export interface CatalogSyncPlan {
  readonly provider: BillingProviderName;
  /** Only changes. `keep_price` lines are for display. */
  readonly actions: readonly CatalogSyncAction[];
}

export interface CatalogSyncResult {
  readonly applied: number;
}

export interface BillingProvider {
  readonly name: BillingProviderName;
  readonly capabilities: ProviderCapabilities;

  /** Creates or reuses the customer of a billing account. Idempotent. */
  ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef>;
  /** A hosted Checkout for the plan price and its usage price. */
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutLink>;
  createPortalSession(input: CreatePortalInput): Promise<PortalLink>;
  listInvoices(input: ListInvoicesInput): Promise<Page<InvoiceSummary>>;

  /** The current truth for one customer. Webhooks, the Checkout return and the sync job all use it. */
  fetchCustomerState(customer: ProviderCustomerRef): Promise<CustomerState>;
  fetchCheckout(checkoutId: string): Promise<CheckoutResult>;
  /**
   * Ends an open Checkout, so it can no longer be paid. A Checkout that is
   * already complete or expired is left as it is. Idempotent.
   */
  expireCheckout(checkoutId: string): Promise<void>;

  /** Verifies the signature and turns a provider event into a normalized event. Throws `ProviderSignatureError`. */
  parseWebhook(input: RawWebhook): Promise<ProviderEvent>;
  /** Events after a cursor, oldest first, for the sync job. `nextCursor` is the cursor to store. */
  listEventsSince(cursor: string | null): Promise<Page<ProviderEvent>>;

  planCatalogSync(catalog: Catalog): Promise<CatalogSyncPlan>;
  applyCatalogSync(plan: CatalogSyncPlan): Promise<CatalogSyncResult>;

  /** Pay-as-you-go (spec 10.10): one meter event, idempotent by `identifier`. */
  reportUsage?(input: UsageReport): Promise<void>;
  /** The subscription billing threshold. */
  setChargeThreshold?(input: ChargeThresholdInput): Promise<void>;
  /** Finalizes and pays a threshold invoice at once. */
  collectThresholdInvoice?(invoiceId: string): Promise<InvoiceSummary>;
  /**
   * Monthly/yearly switch (spec 13). Swaps the plan price and the usage price
   * of the same interval, with proration. The Customer Portal cannot do this,
   * because the subscription has a usage price.
   */
  switchPlanPrice?(input: SwitchPlanPriceInput): Promise<void>;
  /**
   * What `switchPlanPrice` with the same input would charge now: the same
   * items and the same proration, as an invoice preview. Creates nothing.
   */
  previewPlanSwitch?(input: PlanSwitchPreviewInput): Promise<PlanSwitchPreview>;

  /**
   * Start Pro now (decision D22): ends the trial of a trialing subscription at
   * once and charges the first invoice. When the payment fails, nothing
   * changes and it throws `ProviderRejectedError` with `PAYMENT_FAILED`; a
   * subscription that is not trialing throws it with `NOT_TRIALING`.
   */
  endTrialNow?(input: EndTrialInput): Promise<void>;
  /** What `endTrialNow` would charge now. Creates nothing. */
  previewTrialEnd?(input: SubscriptionRef): Promise<InvoicePreview>;

  /**
   * The card that the provider charges: the subscription's default payment
   * method, else the customer's invoice default. One provider call at most.
   * Null without a card (no payment method, or one that is not a card).
   */
  fetchPaymentMethod?(input: PaymentMethodLookup): Promise<PaymentMethodSummary | null>;
}

export interface SwitchPlanPriceInput {
  readonly customer: ProviderCustomerRef;
  readonly subscriptionId: string;
  readonly priceKey: string;
  readonly idempotencyKey: string;
}

/** One subscription of one customer. The provider checks that the subscription belongs to the customer. */
export interface SubscriptionRef {
  readonly customer: ProviderCustomerRef;
  readonly subscriptionId: string;
}

export type PlanSwitchPreviewInput = Omit<SwitchPlanPriceInput, "idempotencyKey">;

export interface EndTrialInput extends SubscriptionRef {
  readonly idempotencyKey: string;
}

/** The money side of an interval switch, as the provider would invoice it now. All amounts are cents, 0 or more. */
export interface PlanSwitchPreview {
  /** What the card is charged now: the invoice amount after the customer's credit balance. */
  readonly chargeTodayCents: number;
  /** The credit for the unused time of the old price (the negative proration lines). */
  readonly creditCents: number;
  /** The customer credit balance left after the invoice, for later invoices. */
  readonly balanceAfterCents: number;
}

export interface InvoicePreview {
  /** What the card is charged now, in cents. */
  readonly amountDueCents: number;
  readonly currency: "usd";
}

export interface PaymentMethodLookup {
  readonly customer: ProviderCustomerRef;
  /** The subscription whose default payment method comes first, or null. */
  readonly subscriptionId: string | null;
}

/** A card on file. Never more than these four fields: no fingerprint, no billing details. */
export interface PaymentMethodSummary {
  /** The card network, such as `visa` or `mastercard`. */
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
}

/** Statuses of a subscription that is not ended. Checkout refuses a customer with one (spec 14). */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"];
/** Statuses after the first payment, so a duplicate keeps the one the customer pays for. */
const PAID_STATUSES: readonly SubscriptionStatus[] = ["active", "past_due", "unpaid", "paused"];

export function isLiveSubscriptionStatus(status: SubscriptionStatus): boolean {
  return LIVE_SUBSCRIPTION_STATUSES.includes(status);
}

/**
 * The subscription that counts (`CustomerState.subscription`), for every
 * provider: the oldest paid live one, else the oldest live one, else the
 * newest ended one. `oldestFirst` is every subscription of the customer.
 */
export function countingSubscription<T extends { readonly status: SubscriptionStatus }>(oldestFirst: readonly T[]): T | null {
  const live = oldestFirst.filter((sub) => isLiveSubscriptionStatus(sub.status));
  return live.find((sub) => PAID_STATUSES.includes(sub.status)) ?? live[0] ?? oldestFirst.at(-1) ?? null;
}
