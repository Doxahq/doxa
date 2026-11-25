import type Stripe from "stripe";

import type { Catalog } from "../../catalog/define";
import { isPlanKey, type PlanKey } from "../../catalog/keys";
import type {
  InvoiceReason,
  InvoiceStatus,
  InvoiceSummary,
  PaymentMethodSummary,
  PlanInvoiceRef,
  PlanSwitchPreview,
  ProviderCustomerRef,
  ProviderSubscription,
  UsageInvoiceRef,
} from "../../provider/provider";
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "../../store/types";
import { STRIPE_PROVIDER, USAGE_PRODUCT_ID } from "./constants";

/** Pure mappings from Stripe objects to provider types. No network. */

export function fromUnix(seconds: number): Date {
  return new Date(seconds * 1000);
}

export function toUnix(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

export function idOf(value: string | { readonly id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.id;
}

export function stripeCustomer(customerId: string): ProviderCustomerRef {
  return { provider: STRIPE_PROVIDER, customerId };
}

export function customerRefOf(value: string | { readonly id: string } | null | undefined): ProviderCustomerRef | null {
  const id = idOf(value);
  return id ? stripeCustomer(id) : null;
}

function subscriptionStatus(status: string): SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(status) ? (status as SubscriptionStatus) : "incomplete";
}

/** A subscription status that still counts. */
export function isLiveSubscription(status: string): boolean {
  return status !== "canceled" && status !== "incomplete_expired";
}

export interface ItemPrice {
  readonly lookupKey: string | null;
  readonly priceId: string;
  readonly productId: string | null;
}

function itemPrice(item: Stripe.SubscriptionItem): ItemPrice {
  return { lookupKey: item.price.lookup_key ?? null, priceId: item.price.id, productId: idOf(item.price.product) };
}

/**
 * The plan side of a subscription: the item on a catalog price, else
 * (Enterprise, spec 13) the item whose product names a plan in
 * `metadata.doxa_plan`. `productPlans` maps product IDs to that plan.
 */
export function mapSubscription(
  subscription: Stripe.Subscription,
  catalog: Catalog,
  productPlans: ReadonlyMap<string, PlanKey>,
): ProviderSubscription | null {
  const items = subscription.items.data;
  const catalogItem = items.find((item) => {
    const key = item.price.lookup_key;
    return key !== null && key !== undefined && Object.hasOwn(catalog.prices, key);
  });
  const usageItem = items.find((item) => {
    const key = item.price.lookup_key;
    return key !== null && key !== undefined && Object.hasOwn(catalog.usagePrices, key);
  });
  const planItem =
    catalogItem ?? items.find((item) => item !== usageItem && productPlans.has(idOf(item.price.product) ?? ""));
  if (!planItem) return null;
  const price = itemPrice(planItem);
  const catalogPrice = price.lookupKey ? catalog.prices[price.lookupKey] : undefined;
  const planKey: PlanKey | null = catalogPrice?.plan ?? (price.productId ? (productPlans.get(price.productId) ?? null) : null);
  const status = subscriptionStatus(subscription.status);
  return {
    subscriptionId: subscription.id,
    // spec: an Enterprise price outside the catalog has no lookup key; its Stripe price ID stands in (never stored in the repo).
    priceKey: price.lookupKey ?? price.priceId,
    usagePriceKey: usageItem?.price.lookup_key ?? null,
    planKey,
    status,
    billingAnchor: fromUnix(subscription.billing_cycle_anchor),
    currentPeriodStart: fromUnix(planItem.current_period_start),
    currentPeriodEnd: fromUnix(planItem.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end || subscription.cancel_at !== null,
    trialEnd: subscription.trial_end !== null ? fromUnix(subscription.trial_end) : null,
    pastDueSince: null,
  };
}

/** Reads `product.metadata.doxa_plan`. */
export function productPlanOf(product: Pick<Stripe.Product, "metadata">): PlanKey | null {
  const plan = product.metadata?.doxa_plan;
  return plan && isPlanKey(plan) ? plan : null;
}

function lineProductId(line: Stripe.InvoiceLineItem): string | null {
  return line.pricing?.price_details?.product ?? null;
}

/** Credits on the usage price lines: the metered quantity of the usage product. */
export function invoiceUsageCredits(invoice: Stripe.Invoice): number {
  let credits = 0;
  for (const line of invoice.lines?.data ?? []) {
    if (lineProductId(line) === USAGE_PRODUCT_ID) credits += line.quantity ?? 0;
  }
  return credits;
}

export function invoiceStatus(invoice: Stripe.Invoice): InvoiceStatus {
  const known: readonly InvoiceStatus[] = ["draft", "open", "paid", "void", "uncollectible"];
  return known.find((status) => status === invoice.status) ?? "draft";
}

export function invoiceReason(invoice: Stripe.Invoice): InvoiceReason {
  if (invoice.billing_reason === "subscription_threshold") return "threshold";
  const direct: readonly InvoiceReason[] = ["subscription_create", "subscription_cycle", "subscription_update", "manual"];
  return direct.find((reason) => reason === invoice.billing_reason) ?? "other";
}

export function isThresholdInvoice(invoice: Stripe.Invoice): boolean {
  return invoice.billing_reason === "subscription_threshold";
}

export function mapInvoice(invoice: Stripe.Invoice): InvoiceSummary {
  return {
    invoiceId: invoice.id,
    status: invoiceStatus(invoice),
    reason: invoiceReason(invoice),
    amountDueCents: invoice.amount_due,
    amountPaidCents: invoice.amount_paid,
    currency: "usd",
    usageCredits: invoiceUsageCredits(invoice),
    createdAt: fromUnix(invoice.created),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
  };
}

export function usageInvoiceRef(invoice: Stripe.Invoice, customerId: string): UsageInvoiceRef {
  const reason: UsageInvoiceRef["reason"] =
    invoice.billing_reason === "subscription_threshold" ? "threshold" : invoice.billing_reason === "subscription_cycle" ? "renewal" : "other";
  return {
    invoiceId: invoice.id,
    customer: stripeCustomer(customerId),
    credits: invoiceUsageCredits(invoice),
    amountCents: invoice.amount_due,
    reason,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  };
}

/** A paid or failed plan invoice: the amount paid, or the amount due when the payment failed. */
export function planInvoiceRef(invoice: Stripe.Invoice, outcome: PlanInvoiceRef["outcome"]): PlanInvoiceRef {
  return {
    invoiceId: invoice.id,
    outcome,
    amountCents: outcome === "paid" ? invoice.amount_paid : invoice.amount_due,
    attempt: invoice.attempt_count ?? null,
  };
}

/** The card of a payment method, or null for a missing, unexpanded or non-card one (Link, a bank account). */
export function cardSummaryOf(method: string | Stripe.PaymentMethod | null | undefined): PaymentMethodSummary | null {
  if (!method || typeof method === "string" || method.type !== "card" || !method.card) return null;
  const { brand, last4, exp_month: expMonth, exp_year: expYear } = method.card;
  return { brand, last4, expMonth, expYear };
}

/** The default payment method of a customer object, when it was expanded. */
export function customerDefaultPaymentMethod(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | Stripe.PaymentMethod | null {
  if (!customer || typeof customer === "string" || customer.deleted) return null;
  return customer.invoice_settings?.default_payment_method ?? null;
}

function isProrationLine(line: Stripe.InvoiceLineItem): boolean {
  const parent = line.parent;
  return parent?.subscription_item_details?.proration === true || parent?.invoice_item_details?.proration === true;
}

/**
 * The money side of a plan switch preview. Stripe's customer balance is
 * negative for a credit; the invoice applies it, so the balance after is
 * `starting_balance + total - amount_due` (a preview has no `ending_balance`).
 */
export function planSwitchPreviewOf(invoice: Stripe.Invoice): PlanSwitchPreview {
  const creditCents = (invoice.lines?.data ?? []).filter((line) => isProrationLine(line) && line.amount < 0).reduce((sum, line) => sum - line.amount, 0);
  const balanceAfter = invoice.starting_balance + invoice.total - invoice.amount_due;
  return { chargeTodayCents: invoice.amount_due, creditCents, balanceAfterCents: Math.max(0, -balanceAfter) };
}
