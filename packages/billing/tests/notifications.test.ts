import { describe, expect, it } from "vitest";
import {
  billingNotificationWindowKey,
  creditNotifications,
  readCreditSnapshot,
  withProjectedDebit,
  type CreditSnapshot,
} from "../src/index";
import { createTestBilling } from "../src/testing";
import { paidProAccount, runJob } from "./helpers/pro";

const windowStart = new Date("2026-11-01T00:00:00.000Z");
const windowEnd = new Date("2026-12-01T00:00:00.000Z");

function snapshot(patch: Partial<CreditSnapshot> = {}): CreditSnapshot {
  return {
    accountId: "acct",
    trialing: false,
    paygActive: true,
    windowStart,
    windowEnd,
    allowance: { amount: 5_000, remaining: 5_000 },
    trial: null,
    grantedCredits: 5_000,
    debtThisWindow: 0,
    monthlyLimitCents: 3_000,
    monthlyLimitCredits: 3_000,
    chargeAtCredits: 500,
    ...patch,
  };
}

const kinds = (s: CreditSnapshot) => creditNotifications(s).map((n) => (n.kind === "payg-limit" ? `payg-limit:${n.percent}` : n.kind));

describe("creditNotifications (billing spec 10.7)", () => {
  it("sends nothing below 80% of the allowance", () => {
    expect(kinds(snapshot({ allowance: { amount: 5_000, remaining: 1_001 } }))).toEqual([]);
  });

  it("sends credits-low at 80% of the allowance", () => {
    const [notice] = creditNotifications(snapshot({ allowance: { amount: 5_000, remaining: 1_000 }, grantedCredits: 1_000 }));
    expect(notice).toMatchObject({ kind: "credits-low", usedCredits: 4_000, allowanceCredits: 5_000, paygOn: true });
  });

  it("sends payg-started, not credits-low, once debt exists this window", () => {
    expect(kinds(snapshot({ allowance: { amount: 5_000, remaining: 0 }, grantedCredits: 0, debtThisWindow: 10 }))).toEqual(["payg-started"]);
  });

  it.each([
    [1_499, []],
    [1_500, ["payg-limit:50"]],
    [2_400, ["payg-limit:80"]],
    [3_000, ["payg-limit:100"]],
  ] as const)("debt %i of a 3,000-credit limit sends %j", (debt, limit) => {
    expect(kinds(snapshot({ allowance: { amount: 5_000, remaining: 0 }, grantedCredits: 0, debtThisWindow: debt }))).toEqual(["payg-started", ...limit]);
  });

  it("sends credits-exhausted for a trial with no credits left, keyed by the trial", () => {
    const trial = { sourceRef: "trial:sub_1", amount: 1_000, remaining: 0 };
    const notices = creditNotifications(snapshot({ trialing: true, paygActive: false, allowance: null, trial, grantedCredits: 0 }));
    expect(notices).toEqual([{ kind: "credits-exhausted", accountId: "acct", windowRef: "trial:sub_1", trialCredits: 1_000 }]);
    expect(billingNotificationWindowKey(notices[0]!)).toBe("credits-exhausted:acct:trial:sub_1");
    expect(kinds(snapshot({ trialing: true, allowance: null, trial: { ...trial, remaining: 5 }, grantedCredits: 5 }))).toEqual([]);
  });

  it("keys each notice by account, kind and window (and limit + step for payg-limit)", () => {
    const notices = creditNotifications(snapshot({ allowance: { amount: 5_000, remaining: 0 }, grantedCredits: 0, debtThisWindow: 3_000 }));
    expect(notices.map(billingNotificationWindowKey)).toEqual([
      "payg-started:acct:2026-11-01T00:00:00.000Z",
      "payg-limit:acct:2026-11-01T00:00:00.000Z:3000:100",
    ]);
  });

  it("projects a shadow debit: grants first, then debt with pay-as-you-go", () => {
    const projected = withProjectedDebit(snapshot({ allowance: { amount: 5_000, remaining: 100 }, grantedCredits: 100 }), 600);
    expect(projected).toMatchObject({ grantedCredits: 0, allowance: { remaining: 0 }, debtThisWindow: 500 });
    const noPayg = withProjectedDebit(snapshot({ paygActive: false, allowance: { amount: 5_000, remaining: 100 }, grantedCredits: 100 }), 600);
    expect(noPayg.debtThisWindow).toBe(0);
  });
});

describe("readCreditSnapshot", () => {
  it("reads the allowance, the debt and the limit of a paid Pro account", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    const deps = { store: billing.store, ledger: billing.ledger, catalog: billing.catalog, clock: billing.clock };

    let snap = await readCreditSnapshot(deps, account.id, await billing.entitlements.creditContext(account.id));
    expect(snap).toMatchObject({ trialing: false, paygActive: true, allowance: { amount: 5_000, remaining: 5_000 }, debtThisWindow: 0, monthlyLimitCredits: 3_000 });

    // 4,000 credits: 50 base + $13.17 × 3 × 100 = 3,951 + 50.
    await runJob(billing, account.id, "j1", 13.17);
    snap = await readCreditSnapshot(deps, account.id, await billing.entitlements.creditContext(account.id));
    expect(snap?.allowance).toEqual({ amount: 5_000, remaining: 999 });
    expect(kinds(snap!)).toEqual(["credits-low"]);

    await runJob(billing, account.id, "j2", 4);
    snap = await readCreditSnapshot(deps, account.id, await billing.entitlements.creditContext(account.id));
    expect(snap?.debtThisWindow).toBeGreaterThan(0);
    expect(kinds(snap!)[0]).toBe("payg-started");
  });
});
