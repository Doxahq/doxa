import Stripe from "stripe";

import type { Catalog } from "../../catalog/define";
import type { PlanKey } from "../../catalog/keys";
import { addMs, type Clock } from "../../clock";
import { NOT_TRIALING, PAYMENT_FAILED, ProviderRejectedError, ProviderSignatureError } from "../../provider/errors";
import {
  CHECKOUT_ID_PLACEHOLDER,
  type BillingProvider,
  type CatalogSyncPlan,
  type CatalogSyncResult,
  type ChargeThresholdInput,
  type CheckoutLink,
  type CheckoutResult,
  type CreateCheckoutInput,
  type CreatePortalInput,
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
  type PortalConfiguration,
  type PortalLink,
  type ProviderCapabilities,
  type ProviderCustomerRef,
  type ProviderEvent,
  type ProviderSubscription,
  type RawWebhook,
  type SubscriptionRef,
  type SwitchPlanPriceInput,
  type UsageReport,
  contactChanges,
  countingSubscription,
  isLiveSubscriptionStatus,
} from "../../provider/provider";
import type { Page } from "../../store/types";
import { callStripe, createStripeClient, isDuplicateMeterEventError, toProviderError, type StripeClient, type StripeClientOptions } from "./client";
import {
  CHECKOUT_MIN_LIFETIME_MS,
  META_ACCOUNT,
  META_MANAGED,
  META_PORTAL,
  META_PRICE_KEY,
  METER_CUSTOMER_KEY,
  METER_EVENT_MAX_AGE_MS,
  METER_VALUE_KEY,
  STRIPE_PROVIDER,
  STRIPE_WEBHOOK_EVENTS,
  WEBHOOK_TOLERANCE_SECONDS,
} from "./constants";
import {
  cardSummaryOf,
  customerDefaultPaymentMethod,
  customerRefOf,
  fromUnix,
  idOf,
  invoiceUsageCredits,
  isLiveSubscription,
  isThresholdInvoice,
  mapInvoice,
  mapSubscription,
  planSwitchPreviewOf,
  productPlanOf,
  stripeCustomer,
  toUnix,
  usageInvoiceRef,
} from "./mapping";
import { applyStripeCatalogSync, planStripeCatalogSync, type DetailedCatalogSyncPlan } from "./sync/catalog-sync";

export interface StripeBillingProviderOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** `STRIPE_MANAGED_PAYMENTS=on`: Stripe is the merchant of record (decision D2). Off: Stripe Tax. */
  readonly managedPayments: boolean;
  readonly catalog: Catalog;
  readonly clock: Clock;
  /** Tests only: a fake HTTP layer. */
  readonly httpClient?: StripeClientOptions["httpClient"];
  readonly maxNetworkRetries?: number;
}

/** The Stripe Checkout placeholder for the session ID in `success_url`. */
const STRIPE_CHECKOUT_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";

const SUBSCRIBED_EVENTS: ReadonlySet<string> = new Set(STRIPE_WEBHOOK_EVENTS);

/**
 * The Stripe provider (spec 13). It moves money and reports Stripe's truth;
 * plans, credits and entitlements stay in Doxa.
 *
 * Doxa never creates an invoice or an invoice item (spec 10.10): Stripe
 * refuses an invoice for a Managed Payments subscription, and an invoice for
 * the customer alone has no Managed Payments. Threshold invoices come from
 * `billing_thresholds`; Doxa only finalizes and pays them.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = STRIPE_PROVIDER;
  readonly capabilities: ProviderCapabilities = { checkout: true, portal: true, invoices: true, refunds: true, usageReporting: true };

  private readonly stripe: StripeClient;
  private readonly options: StripeBillingProviderOptions;
  private readonly portalIds = new Map<PortalConfiguration, string>();
  private readonly productPlans = new Map<string, PlanKey | null>();

  constructor(options: StripeBillingProviderOptions) {
    this.options = options;
    this.stripe = createStripeClient({
      secretKey: options.secretKey,
      ...(options.httpClient ? { httpClient: options.httpClient } : {}),
      ...(options.maxNetworkRetries !== undefined ? { maxNetworkRetries: options.maxNetworkRetries } : {}),
    });
  }

  /** The SDK client, for the catalog sync command and the sandbox contract harness. */
  get client(): StripeClient {
    return this.stripe;
  }

  private now(): Date {
    return this.options.clock.now();
  }

  private customerIdOf(customer: ProviderCustomerRef): string {
    if (customer.provider !== STRIPE_PROVIDER) throw new ProviderRejectedError(`Customer ${customer.customerId} belongs to provider ${customer.provider}, not stripe.`);
    return customer.customerId;
  }

  // Customers ----------------------------------------------------------------------------

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    return callStripe("ensureCustomer", async () => {
      if (input.existing?.provider === STRIPE_PROVIDER) {
        const existing = await this.retrieveCustomer(input.existing.customerId);
        if (existing) return this.syncContact(existing, input);
      }
      // Search is eventually consistent; the idempotency key covers a retry inside that window.
      const found = await this.stripe.customers.search({ query: `metadata['${META_ACCOUNT}']:'${escapeSearch(input.accountId)}'`, limit: 1 });
      const match = found.data[0];
      if (match) return this.syncContact(match, input);
      const created = await this.stripe.customers.create(
        {
          ...(input.email ? { email: input.email } : {}),
          ...(input.name ? { name: input.name } : {}),
          metadata: { [META_ACCOUNT]: input.accountId, [META_MANAGED]: "true" },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return stripeCustomer(created.id);
    });
  }

  /**
   * Sets the account's current email and name on a customer that has others.
   * Checkout shows the customer's email locked, so it must be the owner's
   * email of today. A null value leaves the field as it is.
   */
  private async syncContact(customer: Stripe.Customer, input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const changes = contactChanges({ email: customer.email, name: customer.name ?? null }, input);
    if (changes) await this.stripe.customers.update(customer.id, changes);
    return stripeCustomer(customer.id);
  }

  private async retrieveCustomer(id: string): Promise<Stripe.Customer | null> {
    try {
      const customer = await this.stripe.customers.retrieve(id);
      return customer.deleted ? null : customer;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing") return null;
      throw error;
    }
  }

  // Checkout ---------------------------------------------------------------------------------

  /**
   * The Checkout parameters (spec 13). Exposed for the unit tests that check
   * both parameter sets. Managed Payments refuses `automatic_tax`,
   * `tax_id_collection`, `customer_update`, `payment_method_types`,
   * `invoice_creation`, `custom_text` and `subscription_data.invoice_settings`,
   * so that branch sends none of them.
   */
  checkoutParams(input: CreateCheckoutInput, prices: { readonly plan: string; readonly usage: string }): Stripe.Checkout.SessionCreateParams {
    const customerId = this.customerIdOf(input.customer);
    const minimum = addMs(this.now(), CHECKOUT_MIN_LIFETIME_MS);
    const expiresAt = input.expiresAt > minimum ? input.expiresAt : minimum;
    const metadata = { [META_ACCOUNT]: input.accountId, [META_PRICE_KEY]: input.priceKey };
    const base: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      customer: customerId,
      client_reference_id: input.accountId,
      // A metered price takes no quantity.
      line_items: [{ price: prices.plan, quantity: 1 }, { price: prices.usage }],
      subscription_data: {
        metadata,
        ...(input.trialDays !== null && input.trialDays > 0 ? { trial_period_days: input.trialDays } : {}),
      },
      metadata,
      expires_at: toUnix(expiresAt),
      success_url: input.successUrl.split(CHECKOUT_ID_PLACEHOLDER).join(STRIPE_CHECKOUT_PLACEHOLDER),
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
    };
    if (this.options.managedPayments) return { ...base, managed_payments: { enabled: true } };
    return {
      ...base,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      billing_address_collection: "required",
    };
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutLink> {
    const plan = this.options.catalog.prices[input.priceKey];
    const usage = this.options.catalog.usagePrices[input.usagePriceKey];
    if (!plan || !usage) throw new ProviderRejectedError(`Unknown price ${input.priceKey} or ${input.usagePriceKey}.`);
    // Stripe refuses mixed intervals in one Checkout (spec 10.10); refuse before the call.
    if (plan.interval !== usage.interval) throw new ProviderRejectedError("Checkout does not support multiple prices with different billing intervals.");
    const prices = await this.activePriceIds([input.priceKey, input.usagePriceKey]);
    const planId = prices.get(input.priceKey);
    const usageId = prices.get(input.usagePriceKey);
    if (!planId || !usageId) throw new ProviderRejectedError(`Stripe has no active price for ${planId ? input.usagePriceKey : input.priceKey}. Run the catalog sync.`);
    const params = this.checkoutParams(input, { plan: planId, usage: usageId });
    const session = await callStripe("createCheckout", () => this.stripe.checkout.sessions.create(params, { idempotencyKey: input.idempotencyKey }));
    if (!session.url) throw new ProviderRejectedError(`Checkout Session ${session.id} has no URL.`);
    return { checkoutId: session.id, url: session.url, expiresAt: fromUnix(session.expires_at) };
  }

  /** Price IDs by lookup key, active prices only. Never cached across calls: an archived price must stop new Checkouts. */
  private async activePriceIds(keys: readonly string[]): Promise<Map<string, string>> {
    const page = await callStripe("find prices", () => this.stripe.prices.list({ lookup_keys: [...keys], active: true, limit: 10 }));
    const ids = new Map<string, string>();
    for (const price of page.data) if (price.lookup_key) ids.set(price.lookup_key, price.id);
    return ids;
  }

  async fetchCheckout(checkoutId: string): Promise<CheckoutResult> {
    const session = await callStripe("fetchCheckout", () => this.stripe.checkout.sessions.retrieve(checkoutId));
    return {
      checkoutId: session.id,
      accountId: session.client_reference_id ?? session.metadata?.[META_ACCOUNT] ?? null,
      customer: customerRefOf(session.customer),
      status: session.status === "complete" ? "complete" : session.status === "expired" ? "expired" : "open",
      priceKey: session.metadata?.[META_PRICE_KEY] ?? null,
      url: session.status === "open" ? (session.url ?? null) : null,
      expiresAt: session.expires_at ? fromUnix(session.expires_at) : null,
    };
  }

  async expireCheckout(checkoutId: string): Promise<void> {
    const session = await callStripe("fetchCheckout", () => this.stripe.checkout.sessions.retrieve(checkoutId));
    if (session.status !== "open") return;
    await callStripe("expireCheckout", () => this.stripe.checkout.sessions.expire(checkoutId));
  }

  // Portal ------------------------------------------------------------------------------------

  async createPortalSession(input: CreatePortalInput): Promise<PortalLink> {
    const customerId = this.customerIdOf(input.customer);
    const configuration = await this.portalConfigurationId(input.configuration);
    let flow: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined;
    if (input.flow === "payment_method_update") flow = { type: "payment_method_update" };
    if (input.flow === "subscription_cancel") {
      const subscription = await this.liveSubscription(customerId);
      if (!subscription) throw new ProviderRejectedError("The customer has no subscription to cancel.");
      flow = { type: "subscription_cancel", subscription_cancel: { subscription: subscription.id } };
    }
    const session = await callStripe("createPortalSession", () =>
      this.stripe.billingPortal.sessions.create({ customer: customerId, configuration, return_url: input.returnUrl, ...(flow ? { flow_data: flow } : {}) }),
    );
    return { url: session.url };
  }

  private async portalConfigurationId(name: PortalConfiguration): Promise<string> {
    const cached = this.portalIds.get(name);
    if (cached) return cached;
    await callStripe("find portal configuration", async () => {
      for await (const configuration of this.stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
        const tag = configuration.metadata?.[META_PORTAL];
        if ((tag === "founder" || tag === "standard") && configuration.metadata?.[META_MANAGED] === "true") this.portalIds.set(tag, configuration.id);
      }
    });
    const id = this.portalIds.get(name);
    if (!id) throw new ProviderRejectedError(`Stripe has no "${name}" Customer Portal configuration. Run the catalog sync.`);
    return id;
  }

  // Invoices ----------------------------------------------------------------------------------

  async listInvoices(input: ListInvoicesInput): Promise<Page<InvoiceSummary>> {
    const customerId = this.customerIdOf(input.customer);
    const page = await callStripe("listInvoices", () =>
      this.stripe.invoices.list({ customer: customerId, limit: Math.min(Math.max(input.limit, 1), 100), ...(input.cursor ? { starting_after: input.cursor } : {}) }),
    );
    const items = page.data.map(mapInvoice);
    return { items, nextCursor: page.has_more ? (page.data.at(-1)?.id ?? null) : null };
  }

  // Customer state ----------------------------------------------------------------------------

  async fetchCustomerState(customer: ProviderCustomerRef): Promise<CustomerState> {
    const customerId = this.customerIdOf(customer);
    return callStripe("fetchCustomerState", async () => {
      const found = await this.retrieveCustomer(customerId);
      const { subscription, liveSubscriptions } = await this.customerSubscriptions(customerId);
      let firstPaidInvoiceAt: Date | null = null;
      for await (const invoice of this.stripe.invoices.list({ customer: customerId, status: "paid", limit: 100 })) {
        if (invoice.amount_paid <= 0) continue;
        const paidAt = fromUnix(invoice.status_transitions.paid_at ?? invoice.created);
        if (!firstPaidInvoiceAt || paidAt < firstPaidInvoiceAt) firstPaidInvoiceAt = paidAt;
      }
      return {
        customer: stripeCustomer(customerId),
        accountId: found?.metadata?.[META_ACCOUNT] ?? null,
        subscription,
        liveSubscriptions,
        firstPaidInvoiceAt,
      };
    });
  }

  /**
   * Every Doxa subscription of the customer, oldest first: the one that
   * counts (`countingSubscription`) and the live ones. A subscription
   * outside the catalog and without a plan product is not Doxa's and is left out.
   */
  private async customerSubscriptions(customerId: string): Promise<{ subscription: ProviderSubscription | null; liveSubscriptions: ProviderSubscription[] }> {
    const all: Stripe.Subscription[] = [];
    for await (const subscription of this.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) all.push(subscription);
    all.sort((a, b) => a.created - b.created);
    await this.loadProductPlans(all);
    const plans = this.knownProductPlans();
    const mapped = all.flatMap((subscription) => {
      const sub = mapSubscription(subscription, this.options.catalog, plans);
      return sub ? [sub] : [];
    });
    return { subscription: countingSubscription(mapped), liveSubscriptions: mapped.filter((sub) => isLiveSubscriptionStatus(sub.status)) };
  }

  private async liveSubscription(customerId: string): Promise<Stripe.Subscription | null> {
    return callStripe("find subscription", async () => {
      for await (const subscription of this.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
        if (isLiveSubscription(subscription.status)) return subscription;
      }
      return null;
    });
  }

  /** Reads `metadata.doxa_plan` of products outside the catalog (Enterprise, spec 13), once each. */
  private async loadProductPlans(subscriptions: readonly Stripe.Subscription[]): Promise<void> {
    const catalog = this.options.catalog;
    for (const subscription of subscriptions) {
      for (const item of subscription.items.data) {
        const key = item.price.lookup_key;
        if (key && (Object.hasOwn(catalog.prices, key) || Object.hasOwn(catalog.usagePrices, key))) continue;
        const productId = idOf(item.price.product);
        if (!productId || this.productPlans.has(productId)) continue;
        const product = typeof item.price.product === "object" && !item.price.product.deleted ? item.price.product : await this.stripe.products.retrieve(productId);
        this.productPlans.set(productId, productPlanOf(product));
      }
    }
  }

  private knownProductPlans(): Map<string, PlanKey> {
    const plans = new Map<string, PlanKey>();
    for (const [id, plan] of this.productPlans) if (plan) plans.set(id, plan);
    return plans;
  }

  // Webhooks and events -------------------------------------------------------------------------

  async parseWebhook(input: RawWebhook): Promise<ProviderEvent> {
    const signature = input.headers["stripe-signature"];
    if (!signature) throw new ProviderSignatureError("Missing Stripe-Signature header.");
    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(
        input.body,
        signature,
        this.options.webhookSecret,
        WEBHOOK_TOLERANCE_SECONDS,
        undefined,
        this.now().getTime(),
      );
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) throw new ProviderSignatureError("Bad or expired Stripe signature.");
      if (error instanceof SyntaxError) throw new ProviderSignatureError("Body is not JSON.");
      throw toProviderError(error, "parseWebhook");
    }
    return this.normalize(event);
  }

  async listEventsSince(cursor: string | null): Promise<Page<ProviderEvent>> {
    const page = await callStripe("listEventsSince", () =>
      this.stripe.events.list({ limit: 100, types: [...STRIPE_WEBHOOK_EVENTS], ...(cursor ? { ending_before: cursor } : {}) }),
    );
    // Stripe lists newest first; the page right after the cursor, oldest first.
    const ordered = [...page.data].reverse();
    const items: ProviderEvent[] = [];
    for (const event of ordered) items.push(await this.normalize(event));
    return { items, nextCursor: ordered.at(-1)?.id ?? cursor };
  }

  /** Maps one verified Stripe event to a normalized event (spec 12 and 14.1). */
  async normalize(event: Stripe.Event): Promise<ProviderEvent> {
    const base = { id: event.id, providerType: event.type, occurredAt: fromUnix(event.created) };
    const ignored: ProviderEvent = { ...base, type: "ignored" };
    if (!SUBSCRIBED_EVENTS.has(event.type)) return ignored;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        if (session.mode !== "subscription") return ignored;
        return {
          ...base,
          type: "checkout.completed",
          checkoutId: session.id,
          customer: customerRefOf(session.customer),
          accountId: session.client_reference_id ?? session.metadata?.[META_ACCOUNT] ?? null,
        };
      }
      case "checkout.session.async_payment_failed": {
        const customer = customerRefOf(event.data.object.customer);
        return customer ? { ...base, type: "customer.changed", customer } : ignored;
      }
      case "checkout.session.expired":
        return { ...base, type: "checkout.expired", checkoutId: event.data.object.id };
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
      case "customer.subscription.trial_will_end": {
        const customer = customerRefOf(event.data.object.customer);
        return customer ? { ...base, type: "customer.changed", customer } : ignored;
      }
      case "invoice.created": {
        const invoice = event.data.object;
        const customerId = idOf(invoice.customer);
        if (!customerId || !isThresholdInvoice(invoice)) return ignored;
        return { ...base, type: "usage_invoice.created", invoice: usageInvoiceRef(invoice, customerId) };
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId = idOf(invoice.customer);
        if (!customerId) return ignored;
        if (invoiceUsageCredits(invoice) > 0) {
          return { ...base, type: event.type === "invoice.paid" ? "usage_invoice.paid" : "usage_invoice.failed", invoice: usageInvoiceRef(invoice, customerId) };
        }
        // A subscription invoice: the state (first paid invoice, past due) comes from a fresh fetch.
        return { ...base, type: "customer.changed", customer: stripeCustomer(customerId) };
      }
      case "charge.refunded":
        return this.refundEvent(base, event.data.object);
      case "charge.dispute.created":
        return this.disputeEvent(base, event.data.object);
      default:
        return ignored;
    }
  }

  private async invoiceOfPayment(paymentIntentId: string | null): Promise<Stripe.Invoice | null> {
    if (!paymentIntentId) return null;
    return callStripe("find invoice of payment", async () => {
      const payments = await this.stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: paymentIntentId }, limit: 1 });
      const invoiceId = idOf(payments.data[0]?.invoice ?? null);
      return invoiceId ? this.stripe.invoices.retrieve(invoiceId) : null;
    });
  }

  private async refundEvent(base: { id: string; providerType: string; occurredAt: Date }, charge: Stripe.Charge): Promise<ProviderEvent> {
    const customer = customerRefOf(charge.customer);
    if (!customer) return { ...base, type: "ignored" };
    const invoice = await this.invoiceOfPayment(idOf(charge.payment_intent));
    // spec 10.4: only a usage (threshold) invoice gives credits back; a subscription refund changes none.
    let usageCredits = 0;
    if (invoice && isThresholdInvoice(invoice) && invoice.amount_paid > 0) {
      const credits = invoiceUsageCredits(invoice);
      usageCredits = Math.min(credits, Math.floor((credits * charge.amount_refunded) / invoice.amount_paid));
    }
    return { ...base, type: "payment.refunded", customer, invoiceId: invoice?.id ?? null, amountCents: charge.amount_refunded, usageCredits };
  }

  private async disputeEvent(base: { id: string; providerType: string; occurredAt: Date }, dispute: Stripe.Dispute): Promise<ProviderEvent> {
    const charge = typeof dispute.charge === "string" ? await callStripe("retrieve disputed charge", () => this.stripe.charges.retrieve(dispute.charge as string)) : dispute.charge;
    const customer = customerRefOf(charge.customer);
    if (!customer) return { ...base, type: "ignored" };
    const invoice = await this.invoiceOfPayment(idOf(dispute.payment_intent ?? charge.payment_intent));
    return { ...base, type: "payment.disputed", customer, invoiceId: invoice?.id ?? null };
  }

  // Catalog sync -------------------------------------------------------------------------------

  async planCatalogSync(catalog: Catalog): Promise<CatalogSyncPlan> {
    const plan = await this.planCatalogSyncDetailed(catalog);
    return { provider: plan.provider, actions: plan.actions };
  }

  /** The plan with its `keep` lines, for the printed plan of the sync command. */
  async planCatalogSyncDetailed(catalog: Catalog): Promise<DetailedCatalogSyncPlan> {
    return planStripeCatalogSync(this.stripe, catalog);
  }

  async applyCatalogSync(plan: CatalogSyncPlan): Promise<CatalogSyncResult> {
    const result = await applyStripeCatalogSync(this.stripe, this.options.catalog, plan);
    this.portalIds.clear();
    return result;
  }

  // Pay-as-you-go -----------------------------------------------------------------------------

  /**
   * One meter event (spec 10.10 step 2). Stripe refuses a second event with
   * the same `identifier`; that answer means "already reported", so it is a
   * success here, never an error.
   */
  async reportUsage(input: UsageReport): Promise<void> {
    const customerId = this.customerIdOf(input.customer);
    if (!Number.isSafeInteger(input.credits) || input.credits <= 0) throw new ProviderRejectedError(`Usage credits must be a positive integer, got ${input.credits}.`);
    const meter = this.meterName();
    const now = this.now();
    const oldest = addMs(now, -METER_EVENT_MAX_AGE_MS);
    const at = input.occurredAt < oldest ? oldest : input.occurredAt > now ? now : input.occurredAt;
    try {
      await this.stripe.billing.meterEvents.create(
        {
          event_name: meter,
          identifier: input.identifier,
          timestamp: toUnix(at),
          payload: { [METER_CUSTOMER_KEY]: customerId, [METER_VALUE_KEY]: String(input.credits) },
        },
        { idempotencyKey: `meter-event:${input.identifier}` },
      );
    } catch (error) {
      if (isDuplicateMeterEventError(error)) return;
      throw toProviderError(error, "reportUsage");
    }
  }

  private meterName(): string {
    const meters = [...new Set(Object.values(this.options.catalog.usagePrices).map((usage) => usage.meter))];
    const [meter] = meters;
    if (!meter || meters.length > 1) throw new ProviderRejectedError(`The catalog must name exactly one usage meter, found ${meters.length}.`);
    return meter;
  }

  /** The subscription billing threshold (spec 10.10 step 3 and the sweep). Stripe checks it only when new usage arrives. */
  async setChargeThreshold(input: ChargeThresholdInput): Promise<void> {
    const customerId = this.customerIdOf(input.customer);
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new ProviderRejectedError(`A threshold must be a positive integer, got ${input.amountCents}.`);
    await callStripe("setChargeThreshold", async () => {
      const subscription = await this.stripe.subscriptions.retrieve(input.subscriptionId);
      if (idOf(subscription.customer) !== customerId) throw new ProviderRejectedError(`Subscription ${input.subscriptionId} is not a subscription of ${customerId}.`);
      await this.stripe.subscriptions.update(input.subscriptionId, {
        billing_thresholds: { amount_gte: input.amountCents, reset_billing_cycle_anchor: false },
      });
    });
  }

  /**
   * Finalizes and pays a threshold invoice at once, off-session (spec 10.10
   * step 3), so the charge does not wait an hour for the draft. A declined
   * card is not an error here: the invoice stays open and
   * `invoice.payment_failed` follows.
   */
  async collectThresholdInvoice(invoiceId: string): Promise<InvoiceSummary> {
    let invoice = await callStripe("collectThresholdInvoice", () => this.stripe.invoices.retrieve(invoiceId));
    if (!isThresholdInvoice(invoice)) throw new ProviderRejectedError(`Invoice ${invoiceId} is not a threshold invoice.`, "not_threshold_invoice");
    if (invoice.status === "draft") {
      invoice = await callStripe("finalize invoice", () =>
        this.stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: true }, { idempotencyKey: `collect:${invoiceId}:finalize` }),
      );
    }
    if (invoice.status === "open") {
      try {
        invoice = await this.stripe.invoices.pay(invoiceId, { off_session: true }, { idempotencyKey: `collect:${invoiceId}:pay` });
      } catch (error) {
        if (!(error instanceof Stripe.errors.StripeCardError)) throw toProviderError(error, "pay invoice");
        invoice = await callStripe("collectThresholdInvoice", () => this.stripe.invoices.retrieve(invoiceId));
      }
    }
    return mapInvoice(invoice);
  }

  // Interval switch ---------------------------------------------------------------------------

  /**
   * Switches a subscription to another plan price and swaps the usage price
   * to the same interval (spec 13 and 10.10 step 10). The Customer Portal
   * cannot update a subscription with a usage price, so the dashboard calls
   * this through the API. `BillingProvider.switchPlanPrice` (optional on the
   * port, so a provider without it answers `plan_switch` not configured).
   */
  async switchPlanPrice(input: SwitchPlanPriceInput): Promise<void> {
    const items = await this.planSwitchItems(input);
    await callStripe("switchPlanPrice", () =>
      this.stripe.subscriptions.update(
        input.subscriptionId,
        { items, proration_behavior: PLAN_SWITCH_PRORATION, metadata: { [META_PRICE_KEY]: input.priceKey } },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
  }

  /** The invoice that `switchPlanPrice` would make now: the same items and proration, as a preview. */
  async previewPlanSwitch(input: PlanSwitchPreviewInput): Promise<PlanSwitchPreview> {
    const items = await this.planSwitchItems(input);
    const invoice = await callStripe("previewPlanSwitch", () =>
      this.stripe.invoices.createPreview({
        customer: this.customerIdOf(input.customer),
        subscription: input.subscriptionId,
        subscription_details: { items, proration_behavior: PLAN_SWITCH_PRORATION },
      }),
    );
    return planSwitchPreviewOf(invoice);
  }

  /** The item changes of a switch: the plan item to the new price, the usage item to the usage price of its interval. */
  private async planSwitchItems(input: PlanSwitchPreviewInput): Promise<PlanSwitchItem[]> {
    const price = this.options.catalog.prices[input.priceKey];
    if (!price) throw new ProviderRejectedError(`Unknown price ${input.priceKey}.`);
    const ids = await this.activePriceIds([input.priceKey, price.usage]);
    const planId = ids.get(input.priceKey);
    const usageId = ids.get(price.usage);
    if (!planId || !usageId) throw new ProviderRejectedError(`Stripe has no active price for ${input.priceKey} or ${price.usage}.`);
    const subscription = await this.ownedSubscription(input);
    const catalog = this.options.catalog;
    const planItem = subscription.items.data.find((item) => item.price.lookup_key && Object.hasOwn(catalog.prices, item.price.lookup_key));
    const usageItem = subscription.items.data.find((item) => item.price.lookup_key && Object.hasOwn(catalog.usagePrices, item.price.lookup_key));
    if (!planItem) throw new ProviderRejectedError(`Subscription ${input.subscriptionId} has no catalog plan price.`);
    const items: PlanSwitchItem[] = [{ id: planItem.id, price: planId }];
    if (usageItem?.price.id !== usageId) {
      if (usageItem) items.push({ id: usageItem.id, deleted: true });
      items.push({ price: usageId });
    }
    return items;
  }

  /** The subscription, after a check that it belongs to the customer. */
  private async ownedSubscription(input: SubscriptionRef, expand?: string[]): Promise<Stripe.Subscription> {
    const customerId = this.customerIdOf(input.customer);
    const subscription = await callStripe("retrieve subscription", () =>
      this.stripe.subscriptions.retrieve(input.subscriptionId, expand ? { expand } : undefined),
    );
    if (idOf(subscription.customer) !== customerId) throw new ProviderRejectedError(`Subscription ${input.subscriptionId} is not a subscription of ${customerId}.`);
    return subscription;
  }

  // Start Pro now -------------------------------------------------------------------------------

  /**
   * Ends the trial at once (decision D22). `error_if_incomplete`: when the
   * card refuses the first invoice, Stripe answers 402 and leaves the
   * subscription trialing, so a failed payment never ends the trial.
   */
  async endTrialNow(input: EndTrialInput): Promise<void> {
    const subscription = await this.ownedSubscription(input);
    if (subscription.status !== "trialing") throw new ProviderRejectedError(`Subscription ${input.subscriptionId} is ${subscription.status}, not trialing.`, NOT_TRIALING);
    try {
      await this.stripe.subscriptions.update(
        input.subscriptionId,
        { trial_end: "now", payment_behavior: "error_if_incomplete" },
        { idempotencyKey: input.idempotencyKey },
      );
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError) throw new ProviderRejectedError("The card was declined.", PAYMENT_FAILED, { cause: error });
      throw toProviderError(error, "endTrialNow");
    }
  }

  /** The first invoice that `endTrialNow` would charge now. */
  async previewTrialEnd(input: SubscriptionRef): Promise<InvoicePreview> {
    const invoice = await callStripe("previewTrialEnd", () =>
      this.stripe.invoices.createPreview({
        customer: this.customerIdOf(input.customer),
        subscription: input.subscriptionId,
        subscription_details: { trial_end: "now" },
      }),
    );
    return { amountDueCents: invoice.amount_due, currency: "usd" };
  }

  // Payment method ------------------------------------------------------------------------------

  /**
   * The card Stripe charges, in one call: the subscription with its default
   * payment method and the customer's invoice default expanded, or the
   * customer alone when there is no subscription.
   */
  async fetchPaymentMethod(input: PaymentMethodLookup): Promise<PaymentMethodSummary | null> {
    const customerId = this.customerIdOf(input.customer);
    if (input.subscriptionId) {
      const subscription = await this.ownedSubscription(
        { customer: input.customer, subscriptionId: input.subscriptionId },
        ["default_payment_method", "customer.invoice_settings.default_payment_method"],
      );
      return cardSummaryOf(subscription.default_payment_method) ?? cardSummaryOf(customerDefaultPaymentMethod(subscription.customer));
    }
    const customer = await callStripe("fetchPaymentMethod", () =>
      this.stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] }),
    );
    return cardSummaryOf(customerDefaultPaymentMethod(customer));
  }
}

/** Both the real switch and its preview prorate, so the preview shows what the switch charges. */
const PLAN_SWITCH_PRORATION = "create_prorations" as const;

/** One item change of an interval switch. It fits both the subscription update and the invoice preview. */
type PlanSwitchItem = { readonly id: string; readonly price: string } | { readonly id: string; readonly deleted: true } | { readonly price: string };

/** Escapes a value for a Stripe search query string literal. */
function escapeSearch(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
