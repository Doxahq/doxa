import { isUnlimited } from "../catalog/define";
import { QUOTA_METERS, type QuotaMeterKey } from "../catalog/keys";
import { DAY_MS, addMs, startOfUtcDay, type Clock } from "../clock";
import type { Entitlements } from "../entitlements/resolve";
import type { BillingStore } from "../store/store";

/**
 * Daily quotas (spec section 11): a counter for each account, meter and UTC
 * day. Not a rate limit. One atomic increment per call, so 200 parallel calls
 * with a limit of 100 let exactly 100 through.
 */
export type QuotaResult =
  | { readonly allowed: true; readonly unlimited: true }
  | {
      readonly allowed: boolean;
      readonly unlimited: false;
      readonly count: number;
      readonly limit: number;
      /** 00:00 UTC of the next day. */
      readonly resetsAt: Date;
    };

export class UsageQuota {
  constructor(private readonly deps: { readonly store: BillingStore; readonly clock: Clock }) {}

  /** Counts one use. An account with an unlimited limit skips the write. */
  async consume(meterKey: QuotaMeterKey, accountId: string, entitlements: Entitlements): Promise<QuotaResult> {
    const limit = entitlements.limits[QUOTA_METERS[meterKey]];
    if (isUnlimited(limit)) return { allowed: true, unlimited: true };
    const windowStart = startOfUtcDay(this.deps.clock.now());
    const count = await this.deps.store.incrementUsageCounter({ accountId, meterKey, windowStart });
    return { allowed: count <= limit, unlimited: false, count, limit, resetsAt: addMs(windowStart, DAY_MS) };
  }

  /** Today's count, for `get_account`. */
  async read(meterKey: QuotaMeterKey, accountId: string): Promise<number> {
    return this.deps.store.readUsageCounter({ accountId, meterKey, windowStart: startOfUtcDay(this.deps.clock.now()) });
  }
}
