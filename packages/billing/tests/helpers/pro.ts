import { DAY_MS, DOXA_CATALOG, type ProviderCustomerRef } from "../../src/index";
import type { TestBilling } from "../../src/testing";

/** A paid Pro account: Checkout, trial, trial end with a paid invoice. Webhooks delivered. */
export async function paidProAccount(billing: TestBilling, owner = "pro_user", priceKey = "pro_monthly_v1") {
  const account = await billing.accounts.accountForOwner("user", owner);
  const link = await billing.payments.createCheckout({ accountId: account.id, priceKey, requestId: "r1" });
  billing.provider.completeCheckout(link.checkoutId);
  await billing.deliverWebhooks();
  billing.clock.advance(7 * DAY_MS);
  const customer: ProviderCustomerRef = { provider: "memory", customerId: (await billing.store.getAccount(account.id))!.providerCustomerId! };
  billing.provider.endTrial(customer);
  await billing.deliverWebhooks();
  return { account, customer };
}

/** The monthly credits of Pro, from the catalog. */
export const PRO_ALLOWANCE = DOXA_CATALOG.plans.pro.limits["ai.credits_monthly"] as number;

/** Spends exactly the Pro allowance, in jobs of 5,000 credits (50 + 4,950). */
export async function useAllowance(billing: TestBilling, accountId: string, id: string) {
  for (let index = 0; index * 5_000 < PRO_ALLOWANCE; index += 1) {
    await runJob(billing, accountId, `${id}:${index}`, 16.5);
  }
}

/** Runs one metered job that settles `usd` of model cost. */
export async function runJob(billing: TestBilling, accountId: string, id: string, usd: number) {
  const subject = { kind: "job", id };
  await billing.meter.open({ accountId, actionKey: "generation.run", subject, estimateCredits: 0, capCredits: 5_000 });
  await billing.meter.accrue({ subject, callId: `${id}:c1`, costUsd: usd });
  return billing.meter.settle({ subject, outcome: "succeeded" });
}
