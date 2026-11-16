import { DAY_MS, type CreditContext, type ReserveInput } from "../../src/index";
import { TEST_NOW, createTestBilling, type TestBilling } from "../../src/testing";

/** Pay-as-you-go on (a paid account) or off, with no allowance: grants come from the test. */
export function context(options: { payg?: boolean; trialing?: boolean; windowAnchor?: Date } = {}): CreditContext {
  return {
    enforceCredits: true,
    planAllowsPayg: options.payg ?? false,
    trialing: options.trialing ?? false,
    allowance: null,
    trialGrant: null,
    windowAnchor: options.windowAnchor ?? TEST_NOW,
  };
}

export async function accountWithCredits(
  billing: TestBilling,
  credits: number,
  options: { owner?: string; expiresInDays?: number | null; paygEnabled?: boolean } = {},
) {
  const account = await billing.accounts.accountForOwner("user", options.owner ?? "user_1");
  if (options.paygEnabled === false) await billing.settings.setPayg({ accountId: account.id, enabled: false });
  if (credits > 0) {
    const expiresAt = options.expiresInDays === null ? null : new Date(billing.clock.now().getTime() + (options.expiresInDays ?? 30) * DAY_MS);
    await billing.ledger.grant({ accountId: account.id, kind: "promo", amount: credits, sourceRef: `promo:${credits}:${options.owner ?? "user_1"}`, expiresAt });
  }
  return account;
}

let job = 0;
export function reserveInput(accountId: string, amount: number, extra: Partial<ReserveInput> = {}): ReserveInput {
  job += 1;
  return {
    accountId,
    actionKey: "generation.run",
    subjectKind: "job",
    subjectId: `job_${job}`,
    amount,
    baseCredits: 50,
    capCredits: 3_000,
    markupHundredths: 300,
    unitPriceCents: 1,
    inFlightMarginCredits: 300,
    idempotencyKey: `job:job_${job}:reserve`,
    context: context(),
    ...extra,
  };
}

export { TEST_NOW, createTestBilling };
