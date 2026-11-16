/**
 * What the ledger needs to know about an account beyond its own rows. The
 * caller builds it from the entitlements and the subscription mirror
 * (`creditContextFor` in `entitlements/resolve.ts`). The ledger reads the
 * pay-as-you-go settings and the debt under the account lock itself.
 */
export interface CreditContext {
  /** False for `self_hosted`: the meter opens no reservation. */
  readonly enforceCredits: boolean;
  /** The `ai.payg` feature. */
  readonly planAllowsPayg: boolean;
  readonly trialing: boolean;
  /** The monthly allowance grant to ensure, or null. */
  readonly allowance: { readonly anchor: Date; readonly monthlyCredits: number } | null;
  /** The trial grant to ensure, or null. */
  readonly trialGrant: { readonly sourceRef: string; readonly credits: number; readonly startsAt: Date; readonly endsAt: Date } | null;
  /** The billing anchor that sets the pay-as-you-go month (the allowance window). */
  readonly windowAnchor: Date;
}

/** A context with no grants and no pay-as-you-go, for an account on Free. */
export function freeCreditContext(windowAnchor: Date): CreditContext {
  return { enforceCredits: true, planAllowsPayg: false, trialing: false, allowance: null, trialGrant: null, windowAnchor };
}
