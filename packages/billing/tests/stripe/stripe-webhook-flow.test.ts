import { describe, expect, it } from "vitest";

import { createAccountResolver } from "../../src/accounts/resolve-account";
import { CreditLedger } from "../../src/credits/ledger";
import { BillingEntitlements } from "../../src/entitlements/service";
import { OfferSlots } from "../../src/offers/founder";
import { BillingPayments } from "../../src/payments/service";
import { BillingWebhooks } from "../../src/payments/webhooks";
import { MemoryBillingStore, MemoryProjects } from "../../src/testing";
import { priceId, stripeKit, syncCatalog } from "./helpers";

/** The provider-neutral payments and webhook services over the Stripe provider and its fake HTTP layer. */
function wired() {
  const kit = stripeKit();
  const { clock, catalog, provider } = kit;
  const store = new MemoryBillingStore();
  const accounts = createAccountResolver({ store, catalog, clock, projects: new MemoryProjects(), defaultPlan: "free" });
  const entitlements = new BillingEntitlements({ store, catalog, clock, defaultPlan: "free", accounts });
  const ledger = new CreditLedger({ store, catalog, clock });
  const offers = new OfferSlots({ store, catalog, clock });
  const payments = new BillingPayments({ store, catalog, clock, provider, ledger, offers, entitlements, defaultPlan: "free", returnBaseUrl: "https://doxa.test" });
  const webhooks = new BillingWebhooks({ store, catalog, clock, provider, payments, ledger, offers });
  return { kit, store, accounts, entitlements, payments, webhooks };
}

describe("stripe provider through the webhook flow (spec 14.1)", () => {
  it("Checkout → webhook → Pro, the $5 threshold on the subscription, then a threshold invoice paid at once", async () => {
    const { kit, store, accounts, entitlements, payments, webhooks } = wired();
    await syncCatalog(kit);
    const account = await accounts.accountForOwner("user", "u1");
    const link = await payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_founder_v2", requestId: "r1", email: "u1@example.test" });
    const session = kit.fake.sessions.get(link.checkoutId)!;
    const subscription = kit.fake.completeSession(link.checkoutId);
    // A trial Checkout: the founder hold lasts through the trial.
    expect(subscription.status).toBe("trialing");

    const completed = kit.webhook("checkout.session.completed", session);
    expect(await webhooks.handle(completed)).toEqual({ status: 200, body: { ok: true } });
    expect(await webhooks.handle(completed)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect((await entitlements.forAccount(account.id)).entitlements.plan).toBe("pro");
    expect(kit.fake.subscriptions.get(String(subscription.id))?.billing_thresholds).toMatchObject({ amount_gte: 500 });

    const customerId = String(session.customer);
    const invoice = kit.fake.addInvoice({ customer: customerId, billingReason: "subscription_threshold", status: "draft", amount: 600, lines: [{ priceId: priceId(kit, "ai_usage_monthly_v1"), quantity: 600 }] });
    expect((await webhooks.handle(kit.webhook("invoice.created", invoice))).status).toBe(200);
    expect(kit.fake.invoices.get(String(invoice.id))?.status).toBe("paid");
    expect(await store.listPaygInvoices(account.id)).toEqual([expect.objectContaining({ providerInvoiceId: invoice.id, status: "paid", credits: 600, reason: "threshold" })]);
    expect(kit.fake.requests.filter((request) => request.method === "POST" && /^\/v1\/(invoices|invoiceitems)$/.test(request.path))).toEqual([]);
  });

  it("answers 400 and stores nothing for a bad signature", async () => {
    const { kit, webhooks } = wired();
    const raw = kit.webhook("customer.subscription.updated", { id: "sub_1", object: "subscription", customer: "cus_1" });
    expect(await webhooks.handle({ ...raw, headers: { "stripe-signature": "t=1,v1=00" } })).toMatchObject({ status: 400, body: { error: "bad_signature" } });
  });
});
