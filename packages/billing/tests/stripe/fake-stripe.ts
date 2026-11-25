import Stripe from "stripe";

import type { Clock } from "../../src/clock";

/**
 * A fake Stripe HTTP layer for unit tests (spec 20.3): the real SDK, a fake
 * `fetch`. It keeps just enough state for the Doxa flows, records every
 * request, and answers like Stripe for the cases the sandbox test found
 * (duplicate meter event identifiers, refused invoice creation, mixed
 * intervals in Checkout). No network.
 */

type Json = Record<string, unknown>;

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Json;
  readonly headers: Readonly<Record<string, string>>;
}

class FakeStripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Decodes `a[b][0][c]=x` form or query strings into nested objects and arrays. */
export function decodeStripeParams(text: string): Json {
  const root: Json = {};
  if (!text) return root;
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const [rawKey = "", rawValue = ""] = pair.split("=");
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    const parts = key.replace(/\]/g, "").split("[");
    let node: Json = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) node[part] = value;
      else node = (node[part] ??= {}) as Json;
    });
  }
  const toArrays = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value as Json).map(([key, inner]) => [key, toArrays(inner)] as const);
    if (entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key))) {
      return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, inner]) => inner);
    }
    return Object.fromEntries(entries);
  };
  return toArrays(root) as Json;
}

/** A plan price, not a metered usage price. */
const isLicensed = (price: Json): boolean => (price.recurring as Json | null | undefined)?.usage_type !== "metered";
/** The `expand[]` parameter of a request. */
const expansions = (p: Json): string[] => (Array.isArray(p.expand) ? p.expand.filter((value): value is string => typeof value === "string") : []);
const list = (data: unknown[], url: string) => ({ object: "list", data, has_more: false, url });
const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown) => (typeof value === "string" && value !== "" ? Number(value) : undefined);

export class FakeStripe {
  readonly requests: RecordedRequest[] = [];
  readonly customers = new Map<string, Json>();
  readonly products = new Map<string, Json>();
  readonly prices = new Map<string, Json>();
  readonly meters = new Map<string, Json>();
  readonly meterEvents: Json[] = [];
  readonly portalConfigurations = new Map<string, Json>();
  readonly portalSessions: Json[] = [];
  readonly sessions = new Map<string, Json>();
  readonly subscriptions = new Map<string, Json>();
  readonly invoices = new Map<string, Json>();
  readonly invoicePayments: Json[] = [];
  readonly charges = new Map<string, Json>();
  readonly events: Json[] = [];
  readonly paymentMethods = new Map<string, Json>();
  private readonly idempotent = new Map<string, { status: number; body: unknown }>();
  private readonly meterIdentifiers = new Set<string>();
  private readonly failNextPay = new Set<string>();
  private seq = 1;
  /** Answer the next N requests with a 500. */
  failNext = 0;

  constructor(private readonly clock: Clock) {}

  /** The SDK HTTP client over this fake. */
  get httpClient(): ReturnType<typeof Stripe.createFetchHttpClient> {
    return Stripe.createFetchHttpClient(this.fetch);
  }

  private id(prefix: string): string {
    return `${prefix}_fake${String(this.seq++).padStart(4, "0")}`;
  }

  private nowSeconds(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }

  requestsTo(method: string, pathPrefix: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && request.path.startsWith(pathPrefix));
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const params = method === "GET" || method === "DELETE" ? decodeStripeParams(url.search.slice(1)) : decodeStripeParams(String(init?.body ?? ""));
    this.requests.push({ method, path: url.pathname, params, headers });
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": `req_${this.seq++}` } });
    if (this.failNext > 0) {
      this.failNext -= 1;
      return respond(500, { error: { type: "api_error", message: "Fake Stripe is down." } });
    }
    const key = headers["idempotency-key"];
    const cacheKey = key ? `${method} ${url.pathname} ${key}` : null;
    if (cacheKey && this.idempotent.has(cacheKey)) {
      const cached = this.idempotent.get(cacheKey)!;
      return respond(cached.status, cached.body);
    }
    let status = 200;
    let body: unknown;
    try {
      body = this.route(method, url.pathname, params);
    } catch (error) {
      if (!(error instanceof FakeStripeError)) throw error;
      status = error.status;
      body = { error: { type: error.type, message: error.message, ...(error.code ? { code: error.code } : {}) } };
    }
    if (cacheKey && status < 500) this.idempotent.set(cacheKey, { status, body });
    return respond(status, body);
  };

  private missing(what: string, id: string): never {
    throw new FakeStripeError(404, "invalid_request_error", `No such ${what}: '${id}'`, "resource_missing");
  }

  private route(method: string, path: string, p: Json): unknown {
    const parts = path.split("/").filter(Boolean).slice(1); // drop "v1"
    const [, b, c] = parts;
    const route = `${method} ${parts.map((part, index) => (index > 0 && /_fake\d+$|^(doxa_|evt_|in_|cs_)/.test(part) ? ":id" : part)).join("/")}`;
    switch (route) {
      case "GET account":
        return { id: "acct_fake", object: "account", settings: { dashboard: { display_name: "Doxa Test" } } };
      // Customers
      case "POST customers": {
        const customer = { id: this.id("cus"), object: "customer", email: p.email ?? null, name: p.name ?? null, metadata: p.metadata ?? {} };
        this.customers.set(customer.id, customer);
        return customer;
      }
      case "GET customers/search": {
        const match = /metadata\['([^']+)'\]:'([^']+)'/.exec(String(p.query ?? ""));
        const data = match ? [...this.customers.values()].filter((row) => (row.metadata as Json)[match[1]!] === match[2]) : [];
        return { object: "search_result", data, has_more: false, next_page: null, url: "/v1/customers/search" };
      }
      case "POST customers/:id": {
        const customer = this.customers.get(b!) ?? this.missing("customer", b!);
        Object.assign(customer, { ...(p.email === undefined ? {} : { email: p.email }), ...(p.name === undefined ? {} : { name: p.name }) });
        // Like Stripe: metadata keys merge into the stored ones.
        if (p.metadata) customer.metadata = { ...(customer.metadata as Json), ...(p.metadata as Json) };
        return customer;
      }
      case "GET customers/:id": {
        const customer = this.customers.get(b!) ?? this.missing("customer", b!);
        return this.expandCustomer(customer, expansions(p).includes("invoice_settings.default_payment_method"));
      }
      // Products
      case "POST products": {
        const id = asString(p.id) ?? this.id("prod");
        if (this.products.has(id)) throw new FakeStripeError(400, "invalid_request_error", `Product already exists.`, "resource_already_exists");
        const product = { id, object: "product", name: p.name, active: true, tax_code: p.tax_code ?? null, metadata: p.metadata ?? {} };
        this.products.set(id, product);
        return product;
      }
      case "GET products/:id":
        return this.products.get(b!) ?? this.missing("product", b!);
      case "POST products/:id": {
        const product = this.products.get(b!) ?? this.missing("product", b!);
        Object.assign(product, { ...p, active: p.active === undefined ? product.active : p.active === "true" });
        return product;
      }
      // Prices
      case "POST prices": {
        const key = asString(p.lookup_key);
        if (key && [...this.prices.values()].some((row) => row.lookup_key === key)) {
          throw new FakeStripeError(400, "invalid_request_error", `A price (\`${key}\`) already uses that lookup key.`);
        }
        const recurring = p.recurring as Json | undefined;
        const price = {
          id: this.id("price"),
          object: "price",
          active: true,
          currency: p.currency,
          unit_amount: asNumber(p.unit_amount) ?? null,
          lookup_key: key ?? null,
          nickname: p.nickname ?? null,
          metadata: p.metadata ?? {},
          product: p.product,
          type: "recurring",
          recurring: recurring
            ? { interval: recurring.interval, interval_count: asNumber(recurring.interval_count) ?? 1, usage_type: recurring.usage_type ?? "licensed", meter: recurring.meter ?? null }
            : null,
        };
        this.prices.set(price.id, price);
        return price;
      }
      case "POST prices/:id": {
        const price = this.prices.get(b!) ?? this.missing("price", b!);
        if (p.active !== undefined) price.active = p.active === "true";
        if (p.unit_amount !== undefined) throw new FakeStripeError(400, "invalid_request_error", "Received unknown parameter: unit_amount");
        return price;
      }
      case "GET prices": {
        let data = [...this.prices.values()];
        const keys = p.lookup_keys as string[] | undefined;
        if (keys) data = data.filter((row) => keys.includes(String(row.lookup_key)));
        if (p.product) data = data.filter((row) => row.product === p.product);
        if (p.active !== undefined) data = data.filter((row) => String(row.active) === p.active);
        return list(data, "/v1/prices");
      }
      // Meters
      case "GET billing/meters":
        return list([...this.meters.values()], "/v1/billing/meters");
      case "POST billing/meters": {
        const meter = {
          id: this.id("mtr"),
          object: "billing.meter",
          display_name: p.display_name,
          event_name: p.event_name,
          status: "active",
          default_aggregation: p.default_aggregation,
          customer_mapping: p.customer_mapping,
          value_settings: p.value_settings,
        };
        this.meters.set(meter.id, meter);
        return meter;
      }
      case "POST billing/meters/:id/reactivate": {
        const meter = this.meters.get(c!) ?? this.missing("meter", c!);
        meter.status = "active";
        return meter;
      }
      case "POST billing/meter_events": {
        const identifier = String(p.identifier);
        if (this.meterIdentifiers.has(identifier)) {
          throw new FakeStripeError(400, "invalid_request_error", `An event already exists with identifier ${identifier}.`);
        }
        this.meterIdentifiers.add(identifier);
        const event = { object: "billing.meter_event", event_name: p.event_name, identifier, payload: p.payload, timestamp: asNumber(p.timestamp) };
        this.meterEvents.push(event);
        return event;
      }
      // Portal
      case "GET billing_portal/configurations": {
        let data = [...this.portalConfigurations.values()];
        if (p.active !== undefined) data = data.filter((row) => String(row.active) === p.active);
        return list(data, "/v1/billing_portal/configurations");
      }
      case "POST billing_portal/configurations": {
        const configuration = { id: this.id("bpc"), object: "billing_portal.configuration", active: true, features: p.features, metadata: p.metadata ?? {} };
        this.portalConfigurations.set(configuration.id, configuration);
        return configuration;
      }
      case "POST billing_portal/configurations/:id": {
        const configuration = this.portalConfigurations.get(c!) ?? this.missing("configuration", c!);
        Object.assign(configuration, { features: p.features ?? configuration.features, metadata: p.metadata ?? configuration.metadata, active: p.active === undefined ? configuration.active : p.active === "true" });
        return configuration;
      }
      case "POST billing_portal/sessions": {
        const session = { id: this.id("bps"), object: "billing_portal.session", url: `https://billing.stripe.test/p/session/${this.seq}`, ...p };
        this.portalSessions.push(session);
        return session;
      }
      // Checkout
      case "POST checkout/sessions": {
        const lineItems = (p.line_items as Json[]) ?? [];
        const intervals = new Set(lineItems.map((line) => (this.prices.get(String(line.price))?.recurring as Json | undefined)?.interval));
        if (intervals.size > 1) throw new FakeStripeError(400, "invalid_request_error", "Checkout does not support multiple prices with different billing intervals.");
        const expiresAt = asNumber(p.expires_at) ?? this.nowSeconds() + 24 * 3600;
        if (expiresAt < this.nowSeconds() + 30 * 60) throw new FakeStripeError(400, "invalid_request_error", "expires_at must be at least 30 minutes from now.");
        const session = {
          id: this.id("cs"),
          object: "checkout.session",
          mode: p.mode,
          status: "open",
          customer: p.customer ?? null,
          client_reference_id: p.client_reference_id ?? null,
          metadata: p.metadata ?? {},
          expires_at: expiresAt,
          url: `https://checkout.stripe.test/c/pay/${this.seq}`,
          subscription: null as string | null,
          params: p,
        };
        this.sessions.set(session.id, session);
        return session;
      }
      case "GET checkout/sessions/:id":
        return this.sessions.get(c!) ?? this.missing("checkout session", c!);
      case "POST checkout/sessions/:id/expire": {
        const session = this.sessions.get(c!) ?? this.missing("checkout session", c!);
        if (session.status !== "open") throw new FakeStripeError(400, "invalid_request_error", `Only Checkout Sessions with a status in ["open"] can be expired.`);
        session.status = "expired";
        return session;
      }
      // Subscriptions
      case "GET subscriptions": {
        let data = [...this.subscriptions.values()];
        if (p.customer) data = data.filter((row) => row.customer === p.customer);
        if (p.price) data = data.filter((row) => ((row.items as Json).data as Json[]).some((item) => (item.price as Json).id === p.price));
        if (p.status && p.status !== "all") data = data.filter((row) => row.status === p.status);
        if (!p.status) data = data.filter((row) => row.status !== "canceled");
        return list(data, "/v1/subscriptions");
      }
      case "GET subscriptions/:id": {
        const subscription = this.subscriptions.get(b!) ?? this.missing("subscription", b!);
        return this.expandSubscription(subscription, expansions(p));
      }
      case "POST subscriptions/:id": {
        const subscription = this.subscriptions.get(b!) ?? this.missing("subscription", b!);
        if (p.trial_end !== undefined) this.endTrial(subscription, p);
        if (p.billing_thresholds !== undefined) {
          const thresholds = p.billing_thresholds as Json;
          subscription.billing_thresholds = { amount_gte: asNumber(thresholds.amount_gte), reset_billing_cycle_anchor: thresholds.reset_billing_cycle_anchor === "true" };
        }
        if (p.cancel_at_period_end !== undefined) subscription.cancel_at_period_end = p.cancel_at_period_end === "true";
        if (p.items) {
          const items = subscription.items as { data: Json[] };
          for (const change of p.items as Json[]) {
            if (change.deleted === "true") items.data = items.data.filter((item) => item.id !== change.id);
            else if (change.id) {
              const item = items.data.find((row) => row.id === change.id);
              if (item) item.price = this.prices.get(String(change.price));
            } else items.data.push(this.item(String(change.price), subscription.id as string));
          }
        }
        return subscription;
      }
      // Invoices
      case "POST invoices":
        throw new FakeStripeError(400, "invalid_request_error", "Invoices cannot be created for Subscriptions with Managed Payments enabled.");
      case "POST invoiceitems":
        throw new FakeStripeError(400, "invalid_request_error", "Invoice items are not allowed in this test.");
      case "GET invoices": {
        let data = [...this.invoices.values()].sort((x, y) => Number(y.created) - Number(x.created));
        if (p.customer) data = data.filter((row) => row.customer === p.customer);
        if (p.status) data = data.filter((row) => row.status === p.status);
        const after = asString(p.starting_after);
        if (after) data = data.slice(data.findIndex((row) => row.id === after) + 1);
        const limit = asNumber(p.limit) ?? 10;
        return { ...list(data.slice(0, limit), "/v1/invoices"), has_more: data.length > limit };
      }
      case "POST invoices/create_preview":
        return this.previewInvoice(p);
      case "GET invoices/:id":
        return this.invoices.get(b!) ?? this.missing("invoice", b!);
      case "POST invoices/:id/finalize": {
        const invoice = this.invoices.get(b!) ?? this.missing("invoice", b!);
        if (invoice.status !== "draft") throw new FakeStripeError(400, "invalid_request_error", "This invoice is already finalized.");
        invoice.status = "open";
        return invoice;
      }
      case "POST invoices/:id/pay": {
        const invoice = this.invoices.get(b!) ?? this.missing("invoice", b!);
        if (invoice.status !== "open") throw new FakeStripeError(400, "invalid_request_error", "Invoice is not open.");
        if (this.failNextPay.delete(String(invoice.customer))) {
          throw new FakeStripeError(402, "card_error", "Your card was declined.", "card_declined");
        }
        invoice.status = "paid";
        invoice.amount_paid = invoice.amount_due;
        invoice.status_transitions = { paid_at: this.nowSeconds() };
        return invoice;
      }
      case "GET invoice_payments": {
        const payment = p.payment as Json | undefined;
        const data = this.invoicePayments.filter((row) => (row.payment as Json).payment_intent === payment?.payment_intent);
        return list(data, "/v1/invoice_payments");
      }
      case "GET charges/:id":
        return this.charges.get(b!) ?? this.missing("charge", b!);
      case "GET events": {
        let data = [...this.events];
        const before = asString(p.ending_before);
        if (before) data = data.slice(data.findIndex((row) => row.id === before) + 1);
        data.reverse();
        return list(data.slice(0, asNumber(p.limit) ?? 10), "/v1/events");
      }
      default:
        throw new FakeStripeError(404, "invalid_request_error", `Unrecognized request URL (${method}: ${path}).`);
    }
  }

  // Test helpers ---------------------------------------------------------------------------

  /** A card payment method, set as the customer's invoice default, or as a subscription's default. */
  addCard(customerId: string, card: { brand: string; last4: string; expMonth: number; expYear: number }, options: { subscriptionId?: string } = {}): Json {
    const method = {
      id: this.id("pm"),
      object: "payment_method",
      type: "card",
      customer: customerId,
      card: { brand: card.brand, last4: card.last4, exp_month: card.expMonth, exp_year: card.expYear, display_brand: card.brand },
    };
    this.paymentMethods.set(method.id, method);
    if (options.subscriptionId) {
      const subscription = this.subscriptions.get(options.subscriptionId) ?? this.missing("subscription", options.subscriptionId);
      subscription.default_payment_method = method.id;
    } else {
      const customer = this.customers.get(customerId) ?? this.missing("customer", customerId);
      customer.invoice_settings = { default_payment_method: method.id };
    }
    return method;
  }

  private paymentMethodOf(id: unknown): Json | null {
    return typeof id === "string" ? (this.paymentMethods.get(id) ?? null) : null;
  }

  private expandCustomer(customer: Json, expandMethod: boolean): Json {
    const settings = (customer.invoice_settings as Json | undefined) ?? { default_payment_method: null };
    if (!expandMethod) return { ...customer, invoice_settings: settings };
    return { ...customer, invoice_settings: { ...settings, default_payment_method: this.paymentMethodOf(settings.default_payment_method) } };
  }

  private expandSubscription(subscription: Json, expand: readonly string[]): Json {
    const expanded: Json = { ...subscription, default_payment_method: subscription.default_payment_method ?? null };
    if (expand.includes("default_payment_method")) expanded.default_payment_method = this.paymentMethodOf(subscription.default_payment_method);
    const customer = this.customers.get(String(subscription.customer));
    if (customer && expand.some((path) => path.startsWith("customer"))) {
      expanded.customer = this.expandCustomer(customer, expand.includes("customer.invoice_settings.default_payment_method"));
    }
    return expanded;
  }

  /** `trial_end: "now"`: like Stripe, the anchor resets and the first invoice is charged at once. */
  private endTrial(subscription: Json, p: Json): void {
    if (p.trial_end !== "now") throw new FakeStripeError(400, "invalid_request_error", "This fake supports trial_end=now only.");
    if (subscription.status !== "trialing") throw new FakeStripeError(400, "invalid_request_error", "The subscription is not trialing.");
    const customer = String(subscription.customer);
    if (this.failNextPay.delete(customer)) {
      if (p.payment_behavior === "error_if_incomplete") throw new FakeStripeError(402, "card_error", "Your card was declined.", "card_declined");
      subscription.status = "past_due";
      return;
    }
    const now = this.nowSeconds();
    Object.assign(subscription, { status: "active", trial_end: now, billing_cycle_anchor: now });
    const items = (subscription.items as { data: Json[] }).data;
    for (const item of items) Object.assign(item, this.item(String((item.price as Json).id), String(subscription.id)), { id: item.id });
    const plan = items.map((item) => item.price as Json).find(isLicensed);
    if (plan) this.addInvoice({ customer, billingReason: "subscription_update", status: "paid", amount: Number(plan.unit_amount), lines: [{ priceId: String(plan.id), quantity: 1 }] });
  }

  /**
   * `invoices/create_preview`: a trial end now charges the plan price; an item
   * swap credits the unused time of the old plan price and charges the new
   * one, with the customer balance applied, as Stripe does.
   */
  private previewInvoice(p: Json): Json {
    const subscription = this.subscriptions.get(String(p.subscription)) ?? this.missing("subscription", String(p.subscription));
    const details = (p.subscription_details as Json | undefined) ?? {};
    const items = (subscription.items as { data: Json[] }).data;
    const planOf = (item: Json | undefined) => {
      const price = item?.price as Json | undefined;
      return price && isLicensed(price) ? price : undefined;
    };
    const lines: { amount: number; proration: boolean }[] = [];
    if (details.trial_end === "now") {
      const plan = items.map(planOf).find(Boolean);
      lines.push({ amount: Number(plan?.unit_amount ?? 0), proration: false });
    }
    for (const change of (details.items as Json[] | undefined) ?? []) {
      if (!change.id || !change.price) continue;
      const item = items.find((row) => row.id === change.id);
      const old = planOf(item);
      const next = this.prices.get(String(change.price));
      if (!item || !old || !next) continue;
      const start = Number(item.current_period_start);
      const end = Number(item.current_period_end);
      const unused = end > start ? Math.max(0, end - this.nowSeconds()) / (end - start) : 0;
      lines.push({ amount: -Math.round(Number(old.unit_amount) * unused), proration: true }, { amount: Number(next.unit_amount), proration: false });
    }
    const total = lines.reduce((sum, line) => sum + line.amount, 0);
    const startingBalance = Number((this.customers.get(String(subscription.customer)) ?? {}).balance ?? 0);
    return {
      id: `upcoming_${String(this.seq++)}`,
      object: "invoice",
      customer: subscription.customer,
      status: "draft",
      total,
      starting_balance: startingBalance,
      ending_balance: null,
      amount_due: Math.max(0, total + startingBalance),
      lines: {
        object: "list",
        has_more: false,
        data: lines.map((line) => ({
          id: this.id("il"),
          object: "line_item",
          amount: line.amount,
          parent: { type: "subscription_item_details", invoice_item_details: null, subscription_item_details: { proration: line.proration } },
        })),
      },
    };
  }

  private item(priceId: string, subscriptionId: string): Json {
    const now = this.nowSeconds();
    const price = this.prices.get(priceId) ?? this.missing("price", priceId);
    const interval = (price.recurring as Json).interval === "year" ? 365 : 30;
    return { id: this.id("si"), object: "subscription_item", price, quantity: 1, subscription: subscriptionId, current_period_start: now, current_period_end: now + interval * 86_400 };
  }

  /** "Pays" a Checkout Session: a subscription with its items, and a first paid invoice. */
  completeSession(sessionId: string): Json {
    const session = this.sessions.get(sessionId) ?? this.missing("checkout session", sessionId);
    const params = session.params as Json;
    const subscriptionId = this.id("sub");
    const subscriptionData = (params.subscription_data as Json | undefined) ?? {};
    const trialDays = asNumber(subscriptionData.trial_period_days);
    const now = this.nowSeconds();
    const subscription: Json = {
      id: subscriptionId,
      object: "subscription",
      customer: session.customer,
      status: trialDays ? "trialing" : "active",
      created: now,
      billing_cycle_anchor: now,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: trialDays ? now + trialDays * 86_400 : null,
      billing_thresholds: null,
      metadata: subscriptionData.metadata ?? {},
      items: { object: "list", data: ((params.line_items as Json[]) ?? []).map((line) => this.item(String(line.price), subscriptionId)), has_more: false },
    };
    this.subscriptions.set(subscriptionId, subscription);
    session.status = "complete";
    session.subscription = subscriptionId;
    const planPrice = ((subscription.items as Json).data as Json[])[0]?.price as Json;
    this.addInvoice({
      customer: String(session.customer),
      billingReason: "subscription_create",
      status: "paid",
      amount: trialDays ? 0 : Number(planPrice.unit_amount),
      lines: [{ priceId: String(planPrice.id), quantity: 1 }],
    });
    return subscription;
  }

  addInvoice(input: { customer: string; billingReason: string; status: string; amount: number; lines: { priceId: string; quantity: number }[] }): Json {
    const id = this.id("in");
    const invoice: Json = {
      id,
      object: "invoice",
      customer: input.customer,
      status: input.status,
      billing_reason: input.billingReason,
      amount_due: input.amount,
      amount_paid: input.status === "paid" ? input.amount : 0,
      created: this.nowSeconds(),
      hosted_invoice_url: `https://invoice.stripe.test/i/${id}`,
      invoice_pdf: `https://invoice.stripe.test/i/${id}/pdf`,
      status_transitions: { paid_at: input.status === "paid" ? this.nowSeconds() : null },
      lines: {
        object: "list",
        has_more: false,
        data: input.lines.map((line) => {
          const price = this.prices.get(line.priceId) ?? this.missing("price", line.priceId);
          return { id: this.id("il"), object: "line_item", quantity: line.quantity, pricing: { type: "price_details", price_details: { price: price.id, product: price.product } } };
        }),
      },
    };
    this.invoices.set(id, invoice);
    return invoice;
  }

  /** The next `pay` for this customer is declined. */
  declineNextPayment(customerId: string): void {
    this.failNextPay.add(customerId);
  }

  /** Adds a charge paid through an invoice, for refund and dispute events. */
  addCharge(input: { customer: string; invoiceId: string; amount: number; amountRefunded?: number }): Json {
    const paymentIntent = this.id("pi");
    const charge = { id: this.id("ch"), object: "charge", customer: input.customer, payment_intent: paymentIntent, amount: input.amount, amount_refunded: input.amountRefunded ?? 0 };
    this.charges.set(charge.id, charge);
    this.invoicePayments.push({ id: this.id("inpay"), object: "invoice_payment", invoice: input.invoiceId, payment: { type: "payment_intent", payment_intent: paymentIntent } });
    return charge;
  }

  /** An event in the event log, as Stripe would store it. */
  addEvent(type: string, object: Json): Json {
    const event = { id: `evt_${String(this.seq++).padStart(6, "0")}`, object: "event", type, created: this.nowSeconds(), api_version: "2026-10-28.endive", data: { object } };
    this.events.push(event);
    return event;
  }
}
