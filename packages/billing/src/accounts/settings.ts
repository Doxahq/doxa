import type { Catalog } from "../catalog/define";
import type { ActionKey } from "../catalog/keys";
import type { Clock } from "../clock";
import { validateMonthlyLimitCents } from "../credits/payg";
import { meterPricingFor, validateCap } from "../credits/pricing";
import { BillingInputError } from "../errors";
import type { BillingStore } from "../store/store";
import type { BillingAccount } from "../store/types";

/**
 * Account settings that `billing.manage` can change (spec 15.1):
 * pay-as-you-go on or off with its monthly limit, and the cap of each
 * metered action. Neither starts a charge.
 */
export class BillingAccountSettings {
  constructor(private readonly deps: { readonly store: BillingStore; readonly catalog: Catalog; readonly clock: Clock }) {}

  /** `PUT /billing/accounts/:id/payg`. `monthlyLimitCents` from 500 to 20,000, else `BillingInputError` (400). */
  async setPayg(input: { accountId: string; enabled?: boolean; monthlyLimitCents?: number }): Promise<BillingAccount> {
    const monthlyLimitCents =
      input.monthlyLimitCents === undefined ? undefined : validateMonthlyLimitCents(this.deps.catalog, input.monthlyLimitCents);
    return this.deps.store.withAccountLock(input.accountId, this.deps.clock.now(), (tx) =>
      tx.updateAccount({
        ...(input.enabled === undefined ? {} : { paygEnabled: input.enabled }),
        ...(monthlyLimitCents === undefined ? {} : { paygMonthlyLimitCents: monthlyLimitCents }),
      }),
    );
  }

  /** `PUT /billing/accounts/:id/caps`. Each value from `minCap` up to `maxCap`. */
  async setCap(input: { accountId: string; actionKey: ActionKey; capCredits: number }): Promise<BillingAccount> {
    const pricing = meterPricingFor(this.deps.catalog, input.actionKey);
    if (!pricing || pricing.kind !== "metered") {
      throw new BillingInputError("action_not_metered", `Action ${input.actionKey} has no cap.`);
    }
    const capCredits = validateCap(pricing, input.capCredits);
    return this.deps.store.withAccountLock(input.accountId, this.deps.clock.now(), (tx) =>
      tx.updateAccount({ actionCaps: { ...tx.account.actionCaps, [input.actionKey]: capCredits } }),
    );
  }
}
