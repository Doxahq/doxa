import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readBillingConfig } from "../../src/config";
import { ProviderRejectedError, ProviderSignatureError, ProviderUnavailableError } from "../../src/provider/errors";
import { createBillingProvider } from "../../src/provider-registry";
import { STRIPE_API_VERSION } from "../../src/providers/stripe/client";
import { StripeBillingProvider } from "../../src/providers/stripe/stripe-provider";
import { FakeClock } from "../../src/testing";
import { checkoutInput, priceId, stripeKit, syncCatalog, type StripeTestKit } from "./helpers";

const MANAGED_PAYMENTS_REFUSED = ["automatic_tax", "tax_id_collection", "customer_update", "payment_method_types", "invoice_creation", "custom_text"] as const;

async function customer(kit: StripeTestKit, accountId = "acct_1") {
  return kit.provider.ensureCustomer({ accountId, email: "owner@example.test", name: null, existing: null, idempotencyKey: `customer:${accountId}` });
}

async function paidSubscription(kit: StripeTestKit, priceKey = "pro_monthly_founder_v1") {
  await syncCatalog(kit);
  const ref = await customer(kit);
  const link = await kit.provider.createCheckout({ ...checkoutInput(ref.customerId, priceKey, kit.catalog, kit.clock), trialDays: null });
  const subscription = kit.fake.completeSession(link.checkoutId);
  return { ref, link, subscriptionId: String(subscription.id) };
}

function lastCheckoutParams(kit: StripeTestKit) {
  const request = kit.fake.requestsTo("POST", "/v1/checkout/sessions").at(-1);
  if (!request) throw new Error("no checkout request");
  return request;
}

describe("stripe provider: client", () => {
  it("pins one API version on every request", async () => {
    const kit = stripeKit();
    await customer(kit);
    expect(kit.fake.requests.length).toBeGreaterThan(0);
    for (const request of kit.fake.requests) expect(request.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    expect(STRIPE_API_VERSION >= "2025-03-31").toBe(true); // Managed Payments needs basil or later
  });

  it("maps a Stripe 5xx to ProviderUnavailableError and a 4xx to ProviderRejectedError", async () => {
    const kit = stripeKit();
    kit.fake.failNext = 1;
    await expect(customer(kit)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(kit.provider.fetchCheckout("cs_fake9999")).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it("is built by the registry from the stripe settings", () => {
    const config = readBillingConfig({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "rk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      STRIPE_MANAGED_PAYMENTS: "on",
      BILLING_RETURN_BASE_URL: "https://doxa.test",
    });
    const provider = createBillingProvider(config, { catalog: stripeKit().catalog, clock: new FakeClock() });
    expect(provider).toBeInstanceOf(StripeBillingProvider);
    expect(provider.name).toBe("stripe");
  });
});

describe("stripe provider: customers", () => {
  it("creates one customer per account, with the account ID in metadata, and reuses it", async () => {
    const kit = stripeKit();
    const first = await customer(kit);
    const again = await customer(kit);
    const reused = await kit.provider.ensureCustomer({ accountId: "acct_1", email: null, name: null, existing: first, idempotencyKey: "other" });
    expect(again.customerId).toBe(first.customerId);
    expect(reused.customerId).toBe(first.customerId);
    expect(kit.fake.customers.size).toBe(1);
    expect(kit.fake.customers.get(first.customerId)?.metadata).toMatchObject({ doxa_billing_account_id: "acct_1" });
    expect(kit.fake.requestsTo("POST", "/v1/customers")[0]?.headers["idempotency-key"]).toBe("customer:acct_1");
  });
});

describe("stripe provider: customer contact", () => {
  it("sets the owner's new email on the customer, so Checkout shows it locked", async () => {
    const kit = stripeKit();
    const first = await customer(kit);
    await kit.provider.ensureCustomer({ accountId: "acct_1", email: "new-owner@example.test", name: "Ada", existing: first, idempotencyKey: "customer:acct_1" });
    expect(kit.fake.customers.get(first.customerId)).toMatchObject({ email: "new-owner@example.test", name: "Ada" });
    expect(kit.fake.requestsTo("POST", `/v1/customers/${first.customerId}`)).toHaveLength(1);
  });

  it("keeps a field that the input leaves null, and sends no update when nothing changed", async () => {
    const kit = stripeKit();
    const first = await customer(kit);
    await kit.provider.ensureCustomer({ accountId: "acct_1", email: null, name: null, existing: first, idempotencyKey: "customer:acct_1" });
    await kit.provider.ensureCustomer({ accountId: "acct_1", email: "owner@example.test", name: null, existing: first, idempotencyKey: "customer:acct_1" });
    expect(kit.fake.customers.get(first.customerId)?.email).toBe("owner@example.test");
    expect(kit.fake.requestsTo("POST", `/v1/customers/${first.customerId}`)).toHaveLength(0);
  });

  it("updates a customer found by the account search too", async () => {
    const kit = stripeKit();
    const first = await customer(kit);
    await kit.provider.ensureCustomer({ accountId: "acct_1", email: "moved@example.test", name: null, existing: null, idempotencyKey: "customer:acct_1" });
    expect(kit.fake.customers.get(first.customerId)?.email).toBe("moved@example.test");
  });
});

describe("stripe provider: Checkout", () => {
  for (const priceKey of ["pro_monthly_founder_v1", "pro_yearly_founder_v1", "pro_monthly_v1", "pro_yearly_v1"]) {
    it(`sends the plan price and the usage price of the same interval with Managed Payments (${priceKey})`, async () => {
      const kit = stripeKit({ managedPayments: true });
      await syncCatalog(kit);
      const ref = await customer(kit);
      const input = checkoutInput(ref.customerId, priceKey, kit.catalog, kit.clock);
      const link = await kit.provider.createCheckout(input);
      const { params, headers } = lastCheckoutParams(kit);
      const usageKey = kit.catalog.prices[priceKey]!.usage;
      expect(params.mode).toBe("subscription");
      expect(params.line_items).toEqual([{ price: priceId(kit, priceKey), quantity: "1" }, { price: priceId(kit, usageKey) }]);
      expect(params.managed_payments).toEqual({ enabled: "true" });
      for (const refused of MANAGED_PAYMENTS_REFUSED) expect(params).not.toHaveProperty(refused);
      expect(params.subscription_data).not.toHaveProperty("invoice_settings");
      expect(params.subscription_data).toMatchObject({ trial_period_days: "7", metadata: { doxa_billing_account_id: "acct_1", doxa_price_key: priceKey } });
      expect(params.customer).toBe(ref.customerId);
      expect(params.client_reference_id).toBe("acct_1");
      expect(params.allow_promotion_codes).toBe("true");
      expect(params.success_url).toBe("https://doxa.test/dashboard/billing/acct_1?checkout={CHECKOUT_SESSION_ID}");
      expect(Number(params.expires_at)).toBeGreaterThanOrEqual(Math.floor(kit.clock.now().getTime() / 1000) + 30 * 60);
      expect(headers["idempotency-key"]).toBe(input.idempotencyKey);
      expect(link.url).toMatch(/^https:\/\//);
    });
  }

  it("uses the Stripe Tax parameters when Managed Payments is off", async () => {
    const kit = stripeKit({ managedPayments: false });
    await syncCatalog(kit);
    const ref = await customer(kit);
    await kit.provider.createCheckout(checkoutInput(ref.customerId, "pro_yearly_v1", kit.catalog, kit.clock));
    const { params } = lastCheckoutParams(kit);
    expect(params).not.toHaveProperty("managed_payments");
    expect(params.automatic_tax).toEqual({ enabled: "true" });
    expect(params.tax_id_collection).toEqual({ enabled: "true" });
    expect(params.customer_update).toEqual({ address: "auto", name: "auto" });
    expect(params.billing_address_collection).toBe("required");
    expect(params).not.toHaveProperty("payment_method_types");
  });

  it("refuses mixed intervals before calling Stripe", async () => {
    const kit = stripeKit();
    await syncCatalog(kit);
    const ref = await customer(kit);
    const input = { ...checkoutInput(ref.customerId, "pro_yearly_v1", kit.catalog, kit.clock), usagePriceKey: "ai_usage_monthly_v1" };
    await expect(kit.provider.createCheckout(input)).rejects.toThrow("different billing intervals");
    expect(kit.fake.requestsTo("POST", "/v1/checkout/sessions")).toHaveLength(0);
  });

  it("refuses a price that Stripe does not have (catalog not synced)", async () => {
    const kit = stripeKit();
    const ref = await customer(kit);
    await expect(kit.provider.createCheckout(checkoutInput(ref.customerId, "pro_monthly_v1", kit.catalog, kit.clock))).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it("reads a completed Checkout back with its account and price key", async () => {
    const kit = stripeKit();
    const { ref, link } = await paidSubscription(kit, "pro_yearly_founder_v1");
    expect(await kit.provider.fetchCheckout(link.checkoutId)).toEqual({
      checkoutId: link.checkoutId,
      accountId: "acct_1",
      customer: ref,
      status: "complete",
      priceKey: "pro_yearly_founder_v1",
      url: null,
      expiresAt: link.expiresAt,
    });
  });

  it("expires an open Checkout and leaves a completed one as it is", async () => {
    const kit = stripeKit();
    const { link } = await paidSubscription(kit, "pro_yearly_founder_v1");
    await kit.provider.expireCheckout(link.checkoutId);
    expect(kit.fake.requestsTo("POST", `/v1/checkout/sessions/${link.checkoutId}/expire`)).toHaveLength(0);
    expect((await kit.provider.fetchCheckout(link.checkoutId)).status).toBe("complete");
  });
});

describe("stripe provider: customer state and portal", () => {
  it("maps the subscription items to catalog keys", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await paidSubscription(kit, "pro_monthly_founder_v1");
    const state = await kit.provider.fetchCustomerState(ref);
    expect(state.accountId).toBe("acct_1");
    expect(state.subscription).toMatchObject({
      subscriptionId,
      priceKey: "pro_monthly_founder_v1",
      usagePriceKey: "ai_usage_monthly_v1",
      planKey: "pro",
      status: "active",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    });
    expect(state.firstPaidInvoiceAt).toEqual(kit.clock.now());
  });

  it("opens the Portal with the tagged configuration and a cancel flow", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await paidSubscription(kit);
    const founder = [...kit.fake.portalConfigurations.values()].find((row) => (row.metadata as Record<string, string>).doxa_portal === "founder");
    const link = await kit.provider.createPortalSession({ customer: ref, returnUrl: "https://doxa.test/dashboard/billing/acct_1", configuration: "founder", flow: "subscription_cancel" });
    expect(link.url).toMatch(/^https:\/\//);
    const { params } = kit.fake.requestsTo("POST", "/v1/billing_portal/sessions").at(-1)!;
    expect(params).toMatchObject({ customer: ref.customerId, configuration: founder?.id, flow_data: { type: "subscription_cancel", subscription_cancel: { subscription: subscriptionId } } });
  });

  it("switches the interval and swaps the usage price to the same interval", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await paidSubscription(kit, "pro_monthly_founder_v1");
    await kit.provider.switchPlanPrice({ customer: ref, subscriptionId, priceKey: "pro_yearly_founder_v1", idempotencyKey: "switch:1" });
    const state = await kit.provider.fetchCustomerState(ref);
    expect(state.subscription).toMatchObject({ priceKey: "pro_yearly_founder_v1", usagePriceKey: "ai_usage_yearly_v1" });
  });
});

describe("stripe provider: pay-as-you-go", () => {
  it("sets billing_thresholds[amount_gte] on the subscription", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await paidSubscription(kit);
    await kit.provider.setChargeThreshold({ customer: ref, subscriptionId, amountCents: 500 });
    const update = kit.fake.requestsTo("POST", `/v1/subscriptions/${subscriptionId}`).at(-1);
    expect(update?.params).toEqual({ billing_thresholds: { amount_gte: "500", reset_billing_cycle_anchor: "false" } });
    await kit.provider.setChargeThreshold({ customer: ref, subscriptionId, amountCents: 150 });
    expect(kit.fake.subscriptions.get(subscriptionId)?.billing_thresholds).toMatchObject({ amount_gte: 150 });
  });

  it("refuses a threshold on another customer's subscription", async () => {
    const kit = stripeKit();
    const { subscriptionId } = await paidSubscription(kit);
    const other = await customer(kit, "acct_2");
    await expect(kit.provider.setChargeThreshold({ customer: other, subscriptionId, amountCents: 500 })).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it("sends one meter event with the identifier, and treats a duplicate identifier as done", async () => {
    const kit = stripeKit();
    const { ref } = await paidSubscription(kit);
    const report = { customer: ref, identifier: "job:j1:settle", credits: 600, occurredAt: kit.clock.now() };
    await kit.provider.reportUsage(report);
    await kit.provider.reportUsage(report);
    await kit.provider.reportUsage({ ...report, occurredAt: new Date(kit.clock.now().getTime() - 1000) }); // new request, same identifier
    expect(kit.fake.meterEvents).toEqual([
      expect.objectContaining({ event_name: "doxa_ai_overage", identifier: "job:j1:settle", payload: { stripe_customer_id: ref.customerId, value: "600" } }),
    ]);
  });

  it("refuses zero or fractional credits", async () => {
    const kit = stripeKit();
    const { ref } = await paidSubscription(kit);
    await expect(kit.provider.reportUsage({ customer: ref, identifier: "x", credits: 0, occurredAt: kit.clock.now() })).rejects.toBeInstanceOf(ProviderRejectedError);
    await expect(kit.provider.reportUsage({ customer: ref, identifier: "y", credits: 1.5, occurredAt: kit.clock.now() })).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it("finalizes and pays a draft threshold invoice at once", async () => {
    const kit = stripeKit();
    const { ref } = await paidSubscription(kit);
    const invoice = kit.fake.addInvoice({ customer: ref.customerId, billingReason: "subscription_threshold", status: "draft", amount: 600, lines: [{ priceId: priceId(kit, "ai_usage_monthly_v1"), quantity: 600 }] });
    const result = await kit.provider.collectThresholdInvoice(String(invoice.id));
    expect(result).toMatchObject({ status: "paid", reason: "threshold", amountPaidCents: 600, usageCredits: 600 });
    expect(kit.fake.requestsTo("POST", `/v1/invoices/${invoice.id}/finalize`)).toHaveLength(1);
    expect(kit.fake.requestsTo("POST", `/v1/invoices/${invoice.id}/pay`)[0]?.params).toEqual({ off_session: "true" });
    // A second call (a webhook retry) is a no-op.
    expect((await kit.provider.collectThresholdInvoice(String(invoice.id))).status).toBe("paid");
  });

  it("returns an open invoice, not an error, when the card is declined", async () => {
    const kit = stripeKit();
    const { ref } = await paidSubscription(kit);
    const invoice = kit.fake.addInvoice({ customer: ref.customerId, billingReason: "subscription_threshold", status: "draft", amount: 500, lines: [{ priceId: priceId(kit, "ai_usage_monthly_v1"), quantity: 500 }] });
    kit.fake.declineNextPayment(ref.customerId);
    expect((await kit.provider.collectThresholdInvoice(String(invoice.id))).status).toBe("open");
  });

  it("refuses to collect an invoice that is not a threshold invoice", async () => {
    const kit = stripeKit();
    const { ref } = await paidSubscription(kit);
    const invoice = kit.fake.addInvoice({ customer: ref.customerId, billingReason: "subscription_cycle", status: "draft", amount: 15_900, lines: [{ priceId: priceId(kit, "pro_monthly_founder_v1"), quantity: 1 }] });
    await expect(kit.provider.collectThresholdInvoice(String(invoice.id))).rejects.toMatchObject({ providerCode: "not_threshold_invoice" });
  });

  it("lists invoices with usage credits and a cursor", async () => {
    const kit = stripeKit();
    const { ref } = await paidSubscription(kit);
    kit.clock.advance(1000);
    kit.fake.addInvoice({ customer: ref.customerId, billingReason: "subscription_threshold", status: "paid", amount: 600, lines: [{ priceId: priceId(kit, "ai_usage_monthly_v1"), quantity: 600 }] });
    const first = await kit.provider.listInvoices({ customer: ref, limit: 1, cursor: null });
    expect(first.items[0]).toMatchObject({ reason: "threshold", usageCredits: 600, hostedInvoiceUrl: expect.stringMatching(/^https:/) });
    const second = await kit.provider.listInvoices({ customer: ref, limit: 1, cursor: first.nextCursor });
    expect(second.items[0]).toMatchObject({ reason: "subscription_create", usageCredits: 0 });
    expect(second.nextCursor).toBeNull();
  });
});

describe("stripe provider: Doxa never creates an invoice", () => {
  it("makes no invoice or invoice item request in a full flow", async () => {
    const kit = stripeKit();
    const { ref, subscriptionId } = await paidSubscription(kit);
    await kit.provider.setChargeThreshold({ customer: ref, subscriptionId, amountCents: 500 });
    await kit.provider.reportUsage({ customer: ref, identifier: "job:j:settle", credits: 700, occurredAt: kit.clock.now() });
    const invoice = kit.fake.addInvoice({ customer: ref.customerId, billingReason: "subscription_threshold", status: "draft", amount: 700, lines: [{ priceId: priceId(kit, "ai_usage_monthly_v1"), quantity: 700 }] });
    await kit.provider.collectThresholdInvoice(String(invoice.id));
    await kit.provider.listInvoices({ customer: ref, limit: 10, cursor: null });
    await kit.provider.fetchCustomerState(ref);
    expect(kit.fake.requests.filter((request) => request.method === "POST" && /^\/v1\/(invoices|invoiceitems)\/?$/.test(request.path))).toEqual([]);
  });

  it("has no invoice or invoice item create call in the provider source", () => {
    const root = fileURLToPath(new URL("../../src/providers/stripe", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    // `invoices.createPreview` stays allowed: it computes an invoice and stores
    // nothing (the plan switch and Start Pro now previews). Real creates are not.
    const offenders = files.filter((file) => /\b(invoices|invoiceItems)\s*\.\s*(create|addLines)\s*\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("stripe provider: webhooks", () => {
  it("verifies the signature over the raw body", async () => {
    const kit = stripeKit();
    const raw = kit.webhook("checkout.session.expired", { id: "cs_fake0001", object: "checkout.session", mode: "subscription" });
    expect(await kit.provider.parseWebhook(raw)).toMatchObject({ type: "checkout.expired", checkoutId: "cs_fake0001", providerType: "checkout.session.expired" });
    await expect(kit.provider.parseWebhook({ ...raw, body: `${raw.body} ` })).rejects.toBeInstanceOf(ProviderSignatureError);
    await expect(kit.provider.parseWebhook({ body: raw.body, headers: {} })).rejects.toBeInstanceOf(ProviderSignatureError);
    const wrongSecret = { body: raw.body, headers: { "stripe-signature": "t=1,v1=deadbeef" } };
    await expect(kit.provider.parseWebhook(wrongSecret)).rejects.toBeInstanceOf(ProviderSignatureError);
  });

  it("refuses a signature older than 5 minutes", async () => {
    const kit = stripeKit();
    const raw = kit.webhook("customer.subscription.updated", { id: "sub_x", object: "subscription", customer: "cus_x" });
    kit.clock.advance(5 * 60_000 + 1_000);
    await expect(kit.provider.parseWebhook(raw)).rejects.toBeInstanceOf(ProviderSignatureError);
  });

  describe("event mapping", () => {
    const usageLine = (kit: StripeTestKit, quantity: number) => ({ id: "il_1", object: "line_item", quantity, pricing: { type: "price_details", price_details: { price: "price_u", product: "doxa_ai_usage" } } });
    const planLine = { id: "il_2", object: "line_item", quantity: 1, pricing: { type: "price_details", price_details: { price: "price_p", product: "doxa_pro" } } };
    const invoice = (kit: StripeTestKit, reason: string, lines: unknown[], extra: Record<string, unknown> = {}) => ({
      id: "in_fake0100",
      object: "invoice",
      customer: "cus_fake0001",
      billing_reason: reason,
      status: "draft",
      amount_due: 600,
      amount_paid: 0,
      created: 1,
      hosted_invoice_url: "https://invoice.stripe.test/i/1",
      lines: { object: "list", data: lines, has_more: false },
      ...extra,
    });
    const parse = (kit: StripeTestKit, type: string, object: Record<string, unknown>) => kit.provider.parseWebhook(kit.webhook(type, object));

    it("maps a threshold invoice.created to usage_invoice.created and ignores other drafts", async () => {
      const kit = stripeKit();
      expect(await parse(kit, "invoice.created", invoice(kit, "subscription_threshold", [usageLine(kit, 600)]))).toMatchObject({
        type: "usage_invoice.created",
        invoice: { invoiceId: "in_fake0100", customer: { provider: "stripe", customerId: "cus_fake0001" }, credits: 600, amountCents: 600, reason: "threshold" },
      });
      expect(await parse(kit, "invoice.created", invoice(kit, "subscription_cycle", [planLine]))).toMatchObject({ type: "ignored" });
    });

    it("maps paid and failed invoices with usage to usage events, and others to customer.changed", async () => {
      const kit = stripeKit();
      expect(await parse(kit, "invoice.paid", invoice(kit, "subscription_threshold", [usageLine(kit, 600)], { status: "paid" }))).toMatchObject({ type: "usage_invoice.paid", invoice: { credits: 600 } });
      expect(await parse(kit, "invoice.payment_failed", invoice(kit, "subscription_threshold", [usageLine(kit, 600)]))).toMatchObject({ type: "usage_invoice.failed" });
      expect(await parse(kit, "invoice.paid", invoice(kit, "subscription_cycle", [planLine, usageLine(kit, 40)]))).toMatchObject({ type: "usage_invoice.paid", invoice: { credits: 40, reason: "renewal" } });
      expect(await parse(kit, "invoice.paid", invoice(kit, "subscription_create", [planLine]))).toMatchObject({ type: "customer.changed", customer: { customerId: "cus_fake0001" } });
    });

    it("maps Checkout and subscription events", async () => {
      const kit = stripeKit();
      expect(await parse(kit, "checkout.session.completed", { id: "cs_1", object: "checkout.session", mode: "subscription", customer: "cus_1", client_reference_id: "acct_9" })).toMatchObject({
        type: "checkout.completed",
        checkoutId: "cs_1",
        customer: { provider: "stripe", customerId: "cus_1" },
        accountId: "acct_9",
      });
      for (const type of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.trial_will_end"]) {
        expect(await parse(kit, type, { id: "sub_1", object: "subscription", customer: "cus_1" })).toMatchObject({ type: "customer.changed", providerType: type });
      }
      expect(await parse(kit, "customer.created", { id: "cus_1", object: "customer" })).toMatchObject({ type: "ignored" });
    });

    it("maps a refund of a threshold invoice to its credits, and a subscription refund to 0 credits", async () => {
      const kit = stripeKit();
      const { ref } = await paidSubscription(kit);
      const usage = kit.fake.addInvoice({ customer: ref.customerId, billingReason: "subscription_threshold", status: "paid", amount: 600, lines: [{ priceId: priceId(kit, "ai_usage_monthly_v1"), quantity: 600 }] });
      const charge = kit.fake.addCharge({ customer: ref.customerId, invoiceId: String(usage.id), amount: 600, amountRefunded: 300 });
      expect(await parse(kit, "charge.refunded", charge)).toMatchObject({ type: "payment.refunded", customer: ref, invoiceId: usage.id, amountCents: 300, usageCredits: 300 });
      const plan = [...kit.fake.invoices.values()].find((row) => row.billing_reason === "subscription_create")!;
      const planCharge = kit.fake.addCharge({ customer: ref.customerId, invoiceId: String(plan.id), amount: 15_900, amountRefunded: 15_900 });
      expect(await parse(kit, "charge.refunded", planCharge)).toMatchObject({ type: "payment.refunded", usageCredits: 0 });
    });

    it("maps a dispute to payment.disputed with its invoice", async () => {
      const kit = stripeKit();
      const { ref } = await paidSubscription(kit);
      const usage = kit.fake.addInvoice({ customer: ref.customerId, billingReason: "subscription_threshold", status: "paid", amount: 600, lines: [{ priceId: priceId(kit, "ai_usage_monthly_v1"), quantity: 600 }] });
      const charge = kit.fake.addCharge({ customer: ref.customerId, invoiceId: String(usage.id), amount: 600 });
      expect(await parse(kit, "charge.dispute.created", { id: "dp_1", object: "dispute", charge: charge.id, payment_intent: charge.payment_intent, amount: 600 })).toMatchObject({
        type: "payment.disputed",
        customer: ref,
        invoiceId: usage.id,
      });
    });
  });

  it("lists missed events oldest first with a cursor", async () => {
    const kit = stripeKit();
    const first = kit.fake.addEvent("customer.subscription.updated", { id: "sub_1", object: "subscription", customer: "cus_1" });
    kit.fake.addEvent("checkout.session.expired", { id: "cs_9", object: "checkout.session" });
    const page = await kit.provider.listEventsSince(String(first.id));
    expect(page.items.map((event) => event.type)).toEqual(["checkout.expired"]);
    const again = await kit.provider.listEventsSince(page.nextCursor);
    expect(again.items).toEqual([]);
    expect(again.nextCursor).toBe(page.nextCursor);
    const all = await kit.provider.listEventsSince(null);
    expect(all.items.map((event) => event.type)).toEqual(["customer.changed", "checkout.expired"]);
  });
});
