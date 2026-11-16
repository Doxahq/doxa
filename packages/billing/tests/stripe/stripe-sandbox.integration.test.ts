import Stripe from "stripe";
import { describe, it, vi } from "vitest";

import { DOXA_CATALOG } from "../../src/catalog/doxa";
import { systemClock } from "../../src/clock";
import { StripeBillingProvider } from "../../src/providers/stripe/stripe-provider";
import { STRIPE_WEBHOOK_EVENTS } from "../../src/providers/stripe/constants";
import { describeBillingProviderContract, type ProviderContractHarness } from "../../src/testing";

/**
 * The provider contract against a real Stripe sandbox (spec 20.3). Opt-in:
 *
 *   STRIPE_CONTRACT_TESTS=1 BILLING_STRIPE_SANDBOX_KEY=sk_test_... \
 *     [STRIPE_MANAGED_PAYMENTS=on] pnpm --filter @doxahq/billing test stripe-sandbox
 *
 * It syncs the catalog into the sandbox (it creates products, prices, the
 * meter and the Portal configurations), creates test customers and Checkout
 * Sessions. Stripe has no API to pay a hosted Checkout, so each "paid" test
 * prints a Checkout URL and waits until someone pays it with card
 * 4242 4242 4242 4242 (BILLING_STRIPE_SANDBOX_PAY_TIMEOUT_MS, default 10 min).
 * Webhooks come from the sandbox event log, signed locally with a test secret,
 * so the signature check and the mapper run on real event payloads.
 * A live key is refused.
 */
const key = process.env.BILLING_STRIPE_SANDBOX_KEY?.trim() ?? "";
const enabled = process.env.STRIPE_CONTRACT_TESTS === "1" && /^(sk|rk)_test_/.test(key);
const payTimeoutMs = Number(process.env.BILLING_STRIPE_SANDBOX_PAY_TIMEOUT_MS ?? 10 * 60_000);
const LOCAL_WEBHOOK_SECRET = "whsec_contract_local";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let synced: Promise<void> | null = null;

function sandboxHarness(): ProviderContractHarness {
  const provider = new StripeBillingProvider({
    secretKey: key,
    webhookSecret: LOCAL_WEBHOOK_SECRET,
    managedPayments: process.env.STRIPE_MANAGED_PAYMENTS === "on",
    catalog: DOXA_CATALOG,
    clock: systemClock,
  });
  const startedAt = Math.floor(Date.now() / 1000) - 5;
  const seen = new Set<string>();
  synced ??= provider.planCatalogSync(DOXA_CATALOG).then((plan) => provider.applyCatalogSync(plan).then(() => undefined));

  return {
    provider,
    catalog: DOXA_CATALOG,
    async payCheckout(checkoutId) {
      const session = await provider.client.checkout.sessions.retrieve(checkoutId);
      console.log(`\nPay this sandbox Checkout with 4242 4242 4242 4242:\n${session.url}\n`);
      const deadline = Date.now() + payTimeoutMs;
      while (Date.now() < deadline) {
        if ((await provider.fetchCheckout(checkoutId)).status === "complete") return;
        await sleep(3_000);
      }
      throw new Error(`Checkout ${checkoutId} was not paid within ${payTimeoutMs} ms.`);
    },
    async cancelAtPeriodEnd(customer) {
      const list = await provider.client.subscriptions.list({ customer: customer.customerId, limit: 1 });
      const subscription = list.data[0];
      if (!subscription) throw new Error(`No subscription for ${customer.customerId}`);
      await provider.client.subscriptions.update(subscription.id, { cancel_at_period_end: true });
    },
    async nextWebhook() {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const page = await provider.client.events.list({ created: { gte: startedAt }, types: [...STRIPE_WEBHOOK_EVENTS], limit: 100 });
        const event = [...page.data].reverse().find((row) => !seen.has(row.id));
        if (event) {
          seen.add(event.id);
          const body = JSON.stringify(event);
          return { body, headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: body, secret: LOCAL_WEBHOOK_SECRET }) } };
        }
        await sleep(2_000);
      }
      return null;
    },
  };
}

if (enabled) {
  vi.setConfig({ testTimeout: payTimeoutMs + 120_000, hookTimeout: 120_000 });
  describeBillingProviderContract("stripe sandbox", async () => {
    const harness = sandboxHarness();
    await synced;
    return harness;
  });
} else {
  describe("billing provider contract: stripe sandbox", () => {
    it.skip("opt-in: set STRIPE_CONTRACT_TESTS=1 and BILLING_STRIPE_SANDBOX_KEY=sk_test_...", () => {});
  });
}
