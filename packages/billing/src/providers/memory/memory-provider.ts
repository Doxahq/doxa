import { z } from "zod";

import type { Catalog } from "../../catalog/define";
import { PLAN_KEYS } from "../../catalog/keys";
import { DAY_MS, MINUTE_MS, addMs, type Clock } from "../../clock";
import { NOT_TRIALING, PAYMENT_FAILED, ProviderRejectedError, ProviderSignatureError, ProviderUnavailableError } from "../../provider/errors";
import {
  CHECKOUT_ID_PLACEHOLDER,
  type BillingProvider,
  type CatalogSyncAction,
  type CatalogSyncPlan,
  type CatalogSyncResult,
  type ChargeThresholdInput,
  type CheckoutLink,
  type CheckoutResult,
  type CreateCheckoutInput,
  type CreatePortalInput,
  countingSubscription,
  isLiveSubscriptionStatus,
  type CustomerState,
  type EndTrialInput,
  type EnsureCustomerInput,
  type InvoicePreview,
  type InvoiceSummary,
  type ListInvoicesInput,
  type PaymentMethodLookup,
  type PaymentMethodSummary,
  type PlanSwitchPreview,
  type PlanSwitchPreviewInput,
  type PortalLink,
  type ProviderCapabilities,
  type ProviderCustomerRef,
  type ProviderEvent,
  type ProviderSubscription,
  type RawWebhook,
  type SubscriptionRef,
  type SwitchPlanPriceInput,
  type UsageInvoiceRef,
  type UsageReport,
  type CustomerContact,
  contactChanges,
} from "../../provider/provider";
import type { Page, SubscriptionStatus } from "../../store/types";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event without its ID and time, which `emit` fills in. */
export type NewProviderEvent = DistributiveOmit<ProviderEvent, "id" | "occurredAt">;

export const MEMORY_PROVIDER = "memory" as const;
export const MEMORY_SIGNATURE_HEADER = "memory-signature";
const SIGNATURE_TOLERANCE_MS = 5 * MINUTE_MS;
/** The card that a paid memory Checkout saves, like Stripe's test card 4242. */
export const MEMORY_TEST_CARD: PaymentMethodSummary = { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };

type MethodName = keyof Omit<BillingProvider, "name" | "capabilities">;

interface CheckoutRow {
  readonly checkoutId: string;
  readonly accountId: string;
  readonly customer: ProviderCustomerRef;
  readonly priceKey: string;
  readonly usagePriceKey: string;
  readonly trialDays: number | null;
  readonly expiresAt: Date;
  readonly url: string;
  status: "open" | "complete" | "expired";
}

interface SubscriptionRow {
  sub: ProviderSubscription;
  thresholdCents: number | null;
  unbilledCredits: number;
}

/** A deterministic FNV-1a hash, so the memory provider needs no crypto API. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A deterministic fake provider for tests (spec 12.2): a fake clock,
 * scripted events, scripted failures, and Checkout links that a test pays
 * with one call. Webhooks carry a signature over the body, so tests cover
 * the signature path too.
 */
export class MemoryBillingProvider implements BillingProvider {
  readonly name = MEMORY_PROVIDER;
  readonly capabilities: ProviderCapabilities = { checkout: true, portal: true, invoices: true, refunds: true, usageReporting: true };

  private readonly customers = new Map<string, { accountId: string; email: string | null; name: string | null }>();
  private readonly customerKeys = new Map<string, string>();
  private readonly checkouts = new Map<string, CheckoutRow>();
  private readonly checkoutKeys = new Map<string, string>();
  /** Every subscription of each customer, oldest first. */
  private readonly subscriptions = new Map<string, SubscriptionRow[]>();
  private readonly invoices = new Map<string, InvoiceSummary[]>();
  private readonly invoiceOwner = new Map<string, string>();
  private readonly usageIdentifiers = new Set<string>();
  private readonly eventLog: ProviderEvent[] = [];
  private readonly outbox: RawWebhook[] = [];
  private readonly failures = new Map<MethodName, Error[]>();
  private readonly synced = new Set<string>();
  private readonly failingCards = new Set<string>();
  private readonly paymentMethods = new Map<string, PaymentMethodSummary | null>();
  private nextId = 1;
  /** Every Checkout request, for assertions. */
  readonly checkoutRequests: CreateCheckoutInput[] = [];
  /** Every portal session, for assertions. */
  readonly portalSessions: CreatePortalInput[] = [];
  /** Every threshold change, for assertions. */
  readonly thresholdChanges: ChargeThresholdInput[] = [];

  constructor(
    private readonly options: { readonly clock: Clock; readonly catalog: Catalog; readonly webhookSecret?: string },
  ) {}

  private get secret(): string {
    return this.options.webhookSecret ?? "memory_whsec";
  }

  private id(prefix: string): string {
    return `${prefix}_${String(this.nextId++).padStart(4, "0")}`;
  }

  private now(): Date {
    return this.options.clock.now();
  }

  // Scripting ------------------------------------------------------------------

  /** The next call of `method` throws `error`. Several calls queue several failures. */
  failNext(method: MethodName, error: Error = new ProviderUnavailableError(`memory provider: ${method} failed`)): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(error);
    this.failures.set(method, queue);
  }

  /** Charges to this customer fail from now on (card `4000 0000 0000 0341`). */
  setCardFails(customer: ProviderCustomerRef, fails: boolean): void {
    if (fails) this.failingCards.add(customer.customerId);
    else this.failingCards.delete(customer.customerId);
  }

  /** The card on file of a customer, or null for none. A paid Checkout saves `MEMORY_TEST_CARD`. */
  setPaymentMethod(customer: ProviderCustomerRef, card: PaymentMethodSummary | null): void {
    this.paymentMethods.set(customer.customerId, card);
  }

  private maybeFail(method: MethodName): void {
    const error = this.failures.get(method)?.shift();
    if (error) throw error;
  }

  /** Signed webhooks that the provider "sent" since the last drain, oldest first. */
  drainWebhooks(): RawWebhook[] {
    return this.outbox.splice(0, this.outbox.length);
  }

  /** Signs any event as a webhook, for tests of bad and replayed deliveries. */
  signEvent(event: ProviderEvent, at: Date = this.now()): RawWebhook {
    const body = JSON.stringify(event);
    const timestamp = String(at.getTime());
    return { body, headers: { [MEMORY_SIGNATURE_HEADER]: `t=${timestamp},v1=${fnv1a(`${this.secret}.${timestamp}.${body}`)}` } };
  }

  /** Records an event and puts its webhook in the outbox. */
  emit(event: NewProviderEvent & { readonly id?: string; readonly occurredAt?: Date }): ProviderEvent {
    const full = { ...event, id: event.id ?? this.id("evt"), occurredAt: event.occurredAt ?? this.now() } as ProviderEvent;
    this.eventLog.push(full);
    this.outbox.push(this.signEvent(full));
    return full;
  }

  /**
   * "Pays" a Checkout: creates the subscription (trialing when the Checkout
   * had trial days), a first invoice, and the webhooks.
   */
  completeCheckout(checkoutId: string): ProviderSubscription {
    const row = this.checkouts.get(checkoutId);
    if (!row) throw new ProviderRejectedError(`No checkout ${checkoutId}`);
    if (row.status !== "open") throw new ProviderRejectedError(`Checkout ${checkoutId} is ${row.status}`);
    const now = this.now();
    if (row.expiresAt <= now) throw new ProviderRejectedError(`Checkout ${checkoutId} expired`);
    row.status = "complete";
    if (!this.paymentMethods.has(row.customer.customerId)) this.paymentMethods.set(row.customer.customerId, MEMORY_TEST_CARD);
    const price = this.options.catalog.prices[row.priceKey];
    if (!price) throw new ProviderRejectedError(`Unknown price ${row.priceKey}`);
    const trialing = row.trialDays !== null && row.trialDays > 0;
    const periodEnd = trialing ? addMs(now, (row.trialDays ?? 0) * DAY_MS) : addPeriod(now, price.interval);
    const sub: ProviderSubscription = {
      subscriptionId: this.id("sub"),
      priceKey: row.priceKey,
      usagePriceKey: row.usagePriceKey,
      planKey: price.plan,
      status: trialing ? "trialing" : "active",
      billingAnchor: trialing ? periodEnd : now,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      trialEnd: trialing ? periodEnd : null,
      pastDueSince: null,
    };
    // Like Stripe, a second paid Checkout adds a second subscription.
    this.subscriptions.set(row.customer.customerId, [...(this.subscriptions.get(row.customer.customerId) ?? []), { sub, thresholdCents: null, unbilledCredits: 0 }]);
    this.addInvoice(row.customer, {
      status: "paid",
      reason: "subscription_create",
      amountDueCents: trialing ? 0 : price.amountCents,
      amountPaidCents: trialing ? 0 : price.amountCents,
      usageCredits: 0,
    });
    this.emit({ type: "checkout.completed", providerType: "checkout.session.completed", checkoutId, customer: row.customer, accountId: row.accountId });
    this.emit({ type: "customer.changed", providerType: "customer.subscription.created", customer: row.customer });
    return sub;
  }

  /** Expires an open Checkout (also the `BillingProvider` method) and sends `checkout.expired`. */
  async expireCheckout(checkoutId: string): Promise<void> {
    this.maybeFail("expireCheckout");
    const row = this.checkouts.get(checkoutId);
    if (!row || row.status !== "open") return;
    row.status = "expired";
    this.emit({ type: "checkout.expired", providerType: "checkout.session.expired", checkoutId });
  }

  /** Ends the trial: the first paid invoice, or `past_due` when the card fails. */
  endTrial(customer: ProviderCustomerRef): void {
    const row = this.latest(customer);
    if (!row || row.sub.status !== "trialing") return;
    const price = this.options.catalog.prices[row.sub.priceKey];
    if (!price) return;
    const now = this.now();
    const fails = this.failingCards.has(customer.customerId);
    row.sub = {
      ...row.sub,
      status: fails ? "past_due" : "active",
      pastDueSince: fails ? now : null,
      currentPeriodStart: now,
      currentPeriodEnd: addPeriod(now, price.interval),
      trialEnd: row.sub.trialEnd,
    };
    this.addInvoice(customer, {
      status: fails ? "open" : "paid",
      reason: "subscription_cycle",
      amountDueCents: price.amountCents,
      amountPaidCents: fails ? 0 : price.amountCents,
      usageCredits: 0,
    });
    this.emit({ type: "customer.changed", providerType: "customer.subscription.updated", customer });
  }

  setCancelAtPeriodEnd(customer: ProviderCustomerRef, cancel: boolean): void {
    const row = this.mustSubscription(customer);
    row.sub = { ...row.sub, cancelAtPeriodEnd: cancel };
    this.emit({ type: "customer.changed", providerType: "customer.subscription.updated", customer });
  }

  setSubscriptionStatus(customer: ProviderCustomerRef, status: SubscriptionStatus): void {
    const row = this.mustSubscription(customer);
    row.sub = { ...row.sub, status, pastDueSince: status === "past_due" ? (row.sub.pastDueSince ?? this.now()) : null };
    this.emit({ type: "customer.changed", providerType: "customer.subscription.updated", customer });
  }

  /** Refunds an invoice and sends `payment.refunded`. */
  refundInvoice(invoiceId: string): void {
    const customerId = this.invoiceOwner.get(invoiceId);
    const invoice = customerId ? this.invoices.get(customerId)?.find((row) => row.invoiceId === invoiceId) : undefined;
    if (!customerId || !invoice) throw new ProviderRejectedError(`No invoice ${invoiceId}`);
    this.emit({
      type: "payment.refunded",
      providerType: "charge.refunded",
      customer: { provider: MEMORY_PROVIDER, customerId },
      invoiceId,
      amountCents: invoice.amountPaidCents,
      usageCredits: invoice.usageCredits,
    });
  }

  dispute(customer: ProviderCustomerRef, invoiceId: string | null): void {
    this.emit({ type: "payment.disputed", providerType: "charge.dispute.created", customer, invoiceId });
  }

  /** Test helper: a subscription's unbilled usage and threshold. */
  usageState(customer: ProviderCustomerRef): { unbilledCredits: number; thresholdCents: number | null } | null {
    const row = this.latest(customer);
    return row ? { unbilledCredits: row.unbilledCredits, thresholdCents: row.thresholdCents } : null;
  }

  /** The email and name the customer holds, as Checkout would show them. */
  customerContact(customerId: string): CustomerContact | null {
    const row = this.customers.get(customerId);
    return row ? { email: row.email, name: row.name } : null;
  }

  checkoutRow(checkoutId: string): Readonly<CheckoutRow> | null {
    return this.checkouts.get(checkoutId) ?? null;
  }

  /** Test helper: every subscription of the customer, oldest first. */
  subscriptionsOf(customer: ProviderCustomerRef): ProviderSubscription[] {
    return (this.subscriptions.get(customer.customerId) ?? []).map((row) => ({ ...row.sub }));
  }

  /** The row that the scripting helpers change: the newest live subscription, else the newest. */
  private latest(customer: ProviderCustomerRef): SubscriptionRow | undefined {
    const rows = this.subscriptions.get(customer.customerId) ?? [];
    return [...rows].reverse().find((row) => isLiveSubscriptionStatus(row.sub.status)) ?? rows.at(-1);
  }

  private bySubscriptionId(customer: ProviderCustomerRef, subscriptionId: string): SubscriptionRow | undefined {
    return (this.subscriptions.get(customer.customerId) ?? []).find((row) => row.sub.subscriptionId === subscriptionId);
  }

  private mustSubscription(customer: ProviderCustomerRef): SubscriptionRow {
    const row = this.latest(customer);
    if (!row) throw new ProviderRejectedError(`Customer ${customer.customerId} has no subscription`);
    return row;
  }

  private addInvoice(
    customer: ProviderCustomerRef,
    fields: Pick<InvoiceSummary, "status" | "reason" | "amountDueCents" | "amountPaidCents" | "usageCredits">,
  ): InvoiceSummary {
    const invoiceId = this.id("in");
    const invoice: InvoiceSummary = {
      ...fields,
      invoiceId,
      currency: "usd",
      createdAt: this.now(),
      hostedInvoiceUrl: `https://memory.invalid/invoices/${invoiceId}`,
      pdfUrl: `https://memory.invalid/invoices/${invoiceId}.pdf`,
    };
    const list = this.invoices.get(customer.customerId) ?? [];
    list.push(invoice);
    this.invoices.set(customer.customerId, list);
    this.invoiceOwner.set(invoiceId, customer.customerId);
    return invoice;
  }

  private replaceInvoice(invoice: InvoiceSummary): void {
    const customerId = this.invoiceOwner.get(invoice.invoiceId);
    if (!customerId) return;
    const list = this.invoices.get(customerId) ?? [];
    this.invoices.set(
      customerId,
      list.map((row) => (row.invoiceId === invoice.invoiceId ? invoice : row)),
    );
  }

  // BillingProvider ---------------------------------------------------------------

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    this.maybeFail("ensureCustomer");
    const existingId = input.existing && this.customers.has(input.existing.customerId) ? input.existing.customerId : null;
    const known = existingId ?? this.customerKeys.get(input.idempotencyKey) ?? [...this.customers].find(([, row]) => row.accountId === input.accountId)?.[0];
    const row = known ? this.customers.get(known) : undefined;
    if (known && row) {
      const changes = contactChanges(row, input);
      if (changes) this.customers.set(known, { ...row, ...changes });
      return { provider: MEMORY_PROVIDER, customerId: known };
    }
    const customerId = this.id("cus");
    this.customers.set(customerId, { accountId: input.accountId, email: input.email, name: input.name });
    this.customerKeys.set(input.idempotencyKey, customerId);
    return { provider: MEMORY_PROVIDER, customerId };
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutLink> {
    this.maybeFail("createCheckout");
    this.checkoutRequests.push(input);
    const known = this.checkoutKeys.get(input.idempotencyKey);
    const existing = known ? this.checkouts.get(known) : undefined;
    if (existing) return { checkoutId: existing.checkoutId, url: existing.url, expiresAt: existing.expiresAt };
    if (!this.customers.has(input.customer.customerId)) throw new ProviderRejectedError(`No customer ${input.customer.customerId}`);
    const price = this.options.catalog.prices[input.priceKey];
    const usage = this.options.catalog.usagePrices[input.usagePriceKey];
    if (!price || !usage) throw new ProviderRejectedError(`Unknown price ${input.priceKey} or ${input.usagePriceKey}`);
    if (price.interval !== usage.interval) {
      throw new ProviderRejectedError("Checkout does not support multiple prices with different billing intervals.");
    }
    const checkoutId = this.id("cs");
    const row: CheckoutRow = {
      checkoutId,
      accountId: input.accountId,
      customer: input.customer,
      priceKey: input.priceKey,
      usagePriceKey: input.usagePriceKey,
      trialDays: input.trialDays,
      expiresAt: input.expiresAt,
      url: `https://memory.invalid/checkout/${checkoutId}?success=${encodeURIComponent(input.successUrl.replace(CHECKOUT_ID_PLACEHOLDER, checkoutId))}`,
      status: "open",
    };
    this.checkouts.set(checkoutId, row);
    this.checkoutKeys.set(input.idempotencyKey, checkoutId);
    return { checkoutId, url: row.url, expiresAt: row.expiresAt };
  }

  async createPortalSession(input: CreatePortalInput): Promise<PortalLink> {
    this.maybeFail("createPortalSession");
    if (!this.customers.has(input.customer.customerId)) throw new ProviderRejectedError(`No customer ${input.customer.customerId}`);
    this.portalSessions.push(input);
    return { url: `https://memory.invalid/portal/${input.configuration}/${input.customer.customerId}` };
  }

  async listInvoices(input: ListInvoicesInput): Promise<Page<InvoiceSummary>> {
    this.maybeFail("listInvoices");
    const all = [...(this.invoices.get(input.customer.customerId) ?? [])].reverse();
    const start = input.cursor ? Number(input.cursor) : 0;
    const next = start + input.limit;
    return { items: all.slice(start, next), nextCursor: next < all.length ? String(next) : null };
  }

  async fetchCustomerState(customer: ProviderCustomerRef): Promise<CustomerState> {
    this.maybeFail("fetchCustomerState");
    const all = this.subscriptionsOf(customer);
    const firstPaid = (this.invoices.get(customer.customerId) ?? []).find((invoice) => invoice.status === "paid" && invoice.amountPaidCents > 0);
    return {
      customer,
      accountId: this.customers.get(customer.customerId)?.accountId ?? null,
      subscription: countingSubscription(all),
      liveSubscriptions: all.filter((sub) => isLiveSubscriptionStatus(sub.status)),
      firstPaidInvoiceAt: firstPaid?.createdAt ?? null,
    };
  }

  async fetchCheckout(checkoutId: string): Promise<CheckoutResult> {
    this.maybeFail("fetchCheckout");
    const row = this.checkouts.get(checkoutId);
    if (!row) throw new ProviderRejectedError(`No checkout ${checkoutId}`);
    return {
      checkoutId,
      accountId: row.accountId,
      customer: row.customer,
      status: row.status,
      priceKey: row.priceKey,
      url: row.status === "open" ? row.url : null,
      expiresAt: row.expiresAt,
    };
  }

  async parseWebhook(input: RawWebhook): Promise<ProviderEvent> {
    this.maybeFail("parseWebhook");
    const header = input.headers[MEMORY_SIGNATURE_HEADER];
    const match = header ? /^t=(\d+),v1=([0-9a-f]{8})$/.exec(header) : null;
    if (!match) throw new ProviderSignatureError("Missing or malformed signature.");
    const [, timestamp = "", signature = ""] = match;
    if (fnv1a(`${this.secret}.${timestamp}.${input.body}`) !== signature) throw new ProviderSignatureError("Bad signature.");
    if (Math.abs(this.now().getTime() - Number(timestamp)) > SIGNATURE_TOLERANCE_MS) throw new ProviderSignatureError("Signature is too old.");
    let json: unknown;
    try {
      json = JSON.parse(input.body);
    } catch {
      throw new ProviderSignatureError("Body is not JSON.");
    }
    const parsed = providerEventSchema.safeParse(json);
    if (!parsed.success) throw new ProviderRejectedError("Unknown event shape.");
    return parsed.data;
  }

  async listEventsSince(cursor: string | null): Promise<Page<ProviderEvent>> {
    this.maybeFail("listEventsSince");
    const start = cursor ? Number(cursor) : 0;
    const items = this.eventLog.slice(start);
    return { items, nextCursor: String(start + items.length) };
  }

  async planCatalogSync(catalog: Catalog): Promise<CatalogSyncPlan> {
    this.maybeFail("planCatalogSync");
    const actions: CatalogSyncAction[] = [];
    const want = (kind: CatalogSyncAction["kind"], key: string, description: string) => {
      if (!this.synced.has(`${kind}:${key}`)) actions.push({ kind, key, description });
    };
    for (const plan of PLAN_KEYS) {
      if (Object.values(catalog.prices).some((price) => price.plan === plan)) want("create_product", `doxa_${plan}`, `Doxa ${catalog.plans[plan].name}`);
    }
    for (const meter of new Set(Object.values(catalog.usagePrices).map((usage) => usage.meter))) want("create_meter", meter, `meter ${meter}`);
    for (const [key, price] of Object.entries(catalog.prices)) want("create_price", key, `${price.amountCents} cents / ${price.interval}`);
    for (const [key, usage] of Object.entries(catalog.usagePrices)) want("create_price", key, `${usage.unitAmountCents} cent per credit / ${usage.interval}`);
    want("update_portal", "founder", "portal: founder prices");
    want("update_portal", "standard", "portal: standard prices");
    return { provider: MEMORY_PROVIDER, actions };
  }

  async applyCatalogSync(plan: CatalogSyncPlan): Promise<CatalogSyncResult> {
    this.maybeFail("applyCatalogSync");
    for (const action of plan.actions) this.synced.add(`${action.kind}:${action.key}`);
    return { applied: plan.actions.length };
  }

  async reportUsage(input: UsageReport): Promise<void> {
    this.maybeFail("reportUsage");
    if (this.usageIdentifiers.has(input.identifier)) return; // the provider refuses a repeat; to us it is done
    const row = this.mustSubscription(input.customer);
    this.usageIdentifiers.add(input.identifier);
    row.unbilledCredits += input.credits;
    const unit = this.options.catalog.credit.unitPriceCents;
    if (row.thresholdCents !== null && row.unbilledCredits * unit >= row.thresholdCents) {
      const credits = row.unbilledCredits;
      row.unbilledCredits = 0;
      const invoice = this.addInvoice(input.customer, {
        status: "draft",
        reason: "threshold",
        amountDueCents: credits * unit,
        amountPaidCents: 0,
        usageCredits: credits,
      });
      this.emit({ type: "usage_invoice.created", providerType: "invoice.created", invoice: this.usageRef(input.customer, invoice) });
    }
  }

  /** Like Stripe: swaps the plan price and the usage price, then sends `customer.changed`. */
  async switchPlanPrice(input: SwitchPlanPriceInput): Promise<void> {
    const price = this.options.catalog.prices[input.priceKey];
    if (!price) throw new ProviderRejectedError(`Unknown price ${input.priceKey}`);
    const row = this.ownedRow(input);
    row.sub = { ...row.sub, priceKey: input.priceKey, usagePriceKey: price.usage };
    this.emit({ type: "customer.changed", providerType: "customer.subscription.updated", customer: input.customer });
  }

  /** Like Stripe's invoice preview of the same switch: the unused time of the old price is a credit. */
  async previewPlanSwitch(input: PlanSwitchPreviewInput): Promise<PlanSwitchPreview> {
    this.maybeFail("previewPlanSwitch");
    const row = this.ownedRow(input);
    const next = this.options.catalog.prices[input.priceKey];
    const current = this.options.catalog.prices[row.sub.priceKey];
    if (!next || !current) throw new ProviderRejectedError(`Unknown price ${next ? row.sub.priceKey : input.priceKey}`);
    const { currentPeriodStart: start, currentPeriodEnd: end } = row.sub;
    const length = end.getTime() - start.getTime();
    const unused = length > 0 ? Math.max(0, end.getTime() - this.now().getTime()) / length : 0;
    const creditCents = row.sub.status === "trialing" ? 0 : Math.round(current.amountCents * unused);
    const total = next.amountCents - creditCents;
    return { chargeTodayCents: Math.max(0, total), creditCents, balanceAfterCents: Math.max(0, -total) };
  }

  /** Like Stripe with `trial_end: "now"` and `error_if_incomplete`: a declined card changes nothing. */
  async endTrialNow(input: EndTrialInput): Promise<void> {
    this.maybeFail("endTrialNow");
    const row = this.ownedRow(input);
    if (row.sub.status !== "trialing") throw new ProviderRejectedError(`Subscription ${input.subscriptionId} is ${row.sub.status}`, NOT_TRIALING);
    const price = this.options.catalog.prices[row.sub.priceKey];
    if (!price) throw new ProviderRejectedError(`Unknown price ${row.sub.priceKey}`);
    if (this.failingCards.has(input.customer.customerId)) throw new ProviderRejectedError("The card was declined.", PAYMENT_FAILED);
    const now = this.now();
    // Stripe resets the billing anchor to the trial end, so the first paid period starts now.
    row.sub = { ...row.sub, status: "active", billingAnchor: now, currentPeriodStart: now, currentPeriodEnd: addPeriod(now, price.interval), trialEnd: now };
    this.addInvoice(input.customer, { status: "paid", reason: "subscription_update", amountDueCents: price.amountCents, amountPaidCents: price.amountCents, usageCredits: 0 });
    this.emit({ type: "customer.changed", providerType: "customer.subscription.updated", customer: input.customer });
  }

  async previewTrialEnd(input: SubscriptionRef): Promise<InvoicePreview> {
    this.maybeFail("previewTrialEnd");
    const row = this.ownedRow(input);
    const price = this.options.catalog.prices[row.sub.priceKey];
    if (!price) throw new ProviderRejectedError(`Unknown price ${row.sub.priceKey}`);
    return { amountDueCents: price.amountCents, currency: "usd" };
  }

  async fetchPaymentMethod(input: PaymentMethodLookup): Promise<PaymentMethodSummary | null> {
    this.maybeFail("fetchPaymentMethod");
    if (input.subscriptionId) this.ownedRow({ customer: input.customer, subscriptionId: input.subscriptionId });
    return this.paymentMethods.get(input.customer.customerId) ?? null;
  }

  private ownedRow(input: SubscriptionRef): SubscriptionRow {
    const row = this.bySubscriptionId(input.customer, input.subscriptionId);
    if (!row) throw new ProviderRejectedError(`Subscription ${input.subscriptionId} is not a subscription of ${input.customer.customerId}`);
    return row;
  }

  async setChargeThreshold(input: ChargeThresholdInput): Promise<void> {
    this.maybeFail("setChargeThreshold");
    // Like Stripe, a threshold change alone never creates an invoice.
    const row = this.bySubscriptionId(input.customer, input.subscriptionId) ?? this.mustSubscription(input.customer);
    row.thresholdCents = input.amountCents;
    this.thresholdChanges.push(input);
  }

  async collectThresholdInvoice(invoiceId: string): Promise<InvoiceSummary> {
    this.maybeFail("collectThresholdInvoice");
    const customerId = this.invoiceOwner.get(invoiceId);
    const invoice = customerId ? this.invoices.get(customerId)?.find((row) => row.invoiceId === invoiceId) : undefined;
    if (!customerId || !invoice) throw new ProviderRejectedError(`No invoice ${invoiceId}`);
    if (invoice.status === "paid") return invoice;
    const customer: ProviderCustomerRef = { provider: MEMORY_PROVIDER, customerId };
    const fails = this.failingCards.has(customerId);
    const next: InvoiceSummary = fails
      ? { ...invoice, status: "open" }
      : { ...invoice, status: "paid", amountPaidCents: invoice.amountDueCents };
    this.replaceInvoice(next);
    this.emit({
      type: fails ? "usage_invoice.failed" : "usage_invoice.paid",
      providerType: fails ? "invoice.payment_failed" : "invoice.paid",
      invoice: this.usageRef(customer, next),
    });
    return next;
  }

  private usageRef(customer: ProviderCustomerRef, invoice: InvoiceSummary): UsageInvoiceRef {
    return {
      invoiceId: invoice.invoiceId,
      customer,
      credits: invoice.usageCredits,
      amountCents: invoice.amountDueCents,
      reason: invoice.reason === "threshold" ? "threshold" : "other",
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
    };
  }
}

function addPeriod(from: Date, interval: "month" | "year"): Date {
  const next = new Date(from.getTime());
  if (interval === "month") next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

const customerRefSchema = z.object({ provider: z.enum(["stripe", "none", "memory"]), customerId: z.string() });
const base = { id: z.string(), providerType: z.string(), occurredAt: z.coerce.date() };
const usageInvoiceSchema = z.object({
  invoiceId: z.string(),
  customer: customerRefSchema,
  credits: z.number().int(),
  amountCents: z.number().int(),
  reason: z.enum(["threshold", "renewal", "final", "other"]),
  hostedInvoiceUrl: z.string().nullable(),
});
const providerEventSchema: z.ZodType<ProviderEvent> = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("customer.changed"), customer: customerRefSchema }),
  z.object({
    ...base,
    type: z.literal("checkout.completed"),
    checkoutId: z.string(),
    customer: customerRefSchema.nullable(),
    accountId: z.string().nullable(),
  }),
  z.object({ ...base, type: z.literal("checkout.expired"), checkoutId: z.string() }),
  z.object({ ...base, type: z.literal("usage_invoice.created"), invoice: usageInvoiceSchema }),
  z.object({ ...base, type: z.literal("usage_invoice.paid"), invoice: usageInvoiceSchema }),
  z.object({ ...base, type: z.literal("usage_invoice.failed"), invoice: usageInvoiceSchema }),
  z.object({
    ...base,
    type: z.literal("payment.refunded"),
    customer: customerRefSchema,
    invoiceId: z.string().nullable(),
    amountCents: z.number().int(),
    usageCredits: z.number().int(),
  }),
  z.object({ ...base, type: z.literal("payment.disputed"), customer: customerRefSchema, invoiceId: z.string().nullable() }),
  z.object({ ...base, type: z.literal("ignored") }),
]);
