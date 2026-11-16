import Stripe from "stripe";

import type { Catalog } from "../../src/catalog/define";
import { DOXA_CATALOG } from "../../src/catalog/doxa";
import { StripeBillingProvider } from "../../src/providers/stripe/stripe-provider";
import { FakeClock } from "../../src/testing";
import { FakeStripe } from "./fake-stripe";

export const WEBHOOK_SECRET = "whsec_unit_test_secret";

export interface StripeTestKit {
  readonly clock: FakeClock;
  readonly fake: FakeStripe;
  readonly provider: StripeBillingProvider;
  readonly catalog: Catalog;
  /** Signs a body as Stripe would, at the fake clock's time unless given. */
  sign(body: string, at?: Date): Record<string, string>;
  /** A signed webhook for an event object. */
  webhook(type: string, object: Record<string, unknown>): { body: string; headers: Record<string, string> };
}

export function stripeKit(options: { managedPayments?: boolean; catalog?: Catalog } = {}): StripeTestKit {
  const clock = new FakeClock();
  const fake = new FakeStripe(clock);
  const catalog = options.catalog ?? DOXA_CATALOG;
  const provider = new StripeBillingProvider({
    secretKey: "sk_test_unit",
    webhookSecret: WEBHOOK_SECRET,
    managedPayments: options.managedPayments ?? true,
    catalog,
    clock,
    httpClient: fake.httpClient,
    maxNetworkRetries: 0,
  });
  const sign = (body: string, at: Date = clock.now()) => ({
    "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET, timestamp: Math.floor(at.getTime() / 1000) }),
  });
  return {
    clock,
    fake,
    provider,
    catalog,
    sign,
    webhook(type, object) {
      const event = fake.addEvent(type, object);
      const body = JSON.stringify(event);
      return { body, headers: sign(body) };
    },
  };
}

/** Runs the catalog sync, so prices, the meter and the Portal configurations exist. */
export async function syncCatalog(kit: StripeTestKit): Promise<void> {
  const plan = await kit.provider.planCatalogSync(kit.catalog);
  await kit.provider.applyCatalogSync(plan);
}

/** The fake price ID of a catalog key. */
export function priceId(kit: StripeTestKit, key: string): string {
  const price = [...kit.fake.prices.values()].find((row) => row.lookup_key === key);
  if (!price) throw new Error(`No fake price ${key}`);
  return String(price.id);
}

export function checkoutInput(customerId: string, priceKey: string, catalog: Catalog = DOXA_CATALOG, clock = new FakeClock()) {
  const price = catalog.prices[priceKey];
  if (!price) throw new Error(`No price ${priceKey}`);
  return {
    accountId: "acct_1",
    customer: { provider: "stripe" as const, customerId },
    priceKey,
    usagePriceKey: price.usage,
    trialDays: 7,
    expiresAt: new Date(clock.now().getTime() + 30 * 60_000),
    successUrl: "https://doxa.test/dashboard/billing/acct_1?checkout={CHECKOUT_ID}",
    cancelUrl: "https://doxa.test/dashboard/billing/acct_1",
    idempotencyKey: `checkout:acct_1:${priceKey}:req_1`,
  };
}
