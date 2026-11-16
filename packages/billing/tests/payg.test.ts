import { describe, expect, it } from "vitest";

import {
  DOXA_CATALOG,
  debtRoom,
  exhaustedReason,
  paygStatus,
  sweepCredits,
  validateMonthlyLimitCents,
} from "../src/index";
import * as payments from "../src/payments/index";
import { BillingPayments } from "../src/payments/index";
import { checkLedgerInvariant, subscriptionFixture } from "../src/testing";
import { context, createTestBilling, reserveInput } from "./helpers/fixtures";

const catalog = DOXA_CATALOG;
const base = { planAllowsPayg: true, trialing: false, settingEnabled: true, aiPausedReason: null } as const;

describe("pay-as-you-go rules", () => {
  it("sets the floor for each account state", () => {
    expect(paygStatus(catalog, base)).toEqual({ active: true, offReason: null });
    expect(paygStatus(catalog, { ...base, trialing: true })).toEqual({ active: false, offReason: "trial" });
    expect(paygStatus(catalog, { ...base, aiPausedReason: "payment_failed" })).toEqual({ active: false, offReason: "payment_failed" });
    expect(paygStatus(catalog, { ...base, aiPausedReason: "dispute" })).toEqual({ active: false, offReason: "dispute" });
    expect(paygStatus(catalog, { ...base, settingEnabled: false })).toEqual({ active: false, offReason: "setting_off" });
    expect(paygStatus(catalog, { ...base, planAllowsPayg: false })).toEqual({ active: false, offReason: "not_in_plan" });
  });

  it("computes the debt room from the maximum debt and the monthly limit", () => {
    expect(debtRoom(catalog, { active: true, openDebt: 0, debtThisWindow: 0, monthlyLimitCents: 3_000 })).toEqual({ room: 1_000, limitedBy: "max_debt" });
    expect(debtRoom(catalog, { active: true, openDebt: 400, debtThisWindow: 2_800, monthlyLimitCents: 3_000 })).toEqual({ room: 200, limitedBy: "monthly_limit" });
    expect(debtRoom(catalog, { active: true, openDebt: 1_200, debtThisWindow: 0, monthlyLimitCents: 3_000 })).toEqual({ room: 0, limitedBy: "max_debt" });
    expect(debtRoom(catalog, { active: false, openDebt: 0, debtThisWindow: 0, monthlyLimitCents: 3_000 }).room).toBe(0);
  });

  it("refuses a monthly limit outside $5–$200", () => {
    expect(validateMonthlyLimitCents(catalog, 500)).toBe(500);
    expect(validateMonthlyLimitCents(catalog, 20_000)).toBe(20_000);
    for (const bad of [499, 20_001, 1_000.5]) expect(() => validateMonthlyLimitCents(catalog, bad)).toThrow(/from 500 to 20000/);
  });

  it("sweeps only from 50 credits", () => {
    expect(sweepCredits(catalog, 49)).toBe(0);
    expect(sweepCredits(catalog, 50)).toBe(50);
  });

  it("names the 402 reason", () => {
    const room = { room: 0, limitedBy: "max_debt" as const };
    expect(exhaustedReason({ trialing: true, payg: { active: false, offReason: "trial" }, room })).toBe("trial_credits");
    expect(exhaustedReason({ trialing: false, payg: { active: false, offReason: "payment_failed" }, room })).toBe("past_due");
    expect(exhaustedReason({ trialing: false, payg: { active: false, offReason: "setting_off" }, room })).toBe("payg_off");
    expect(exhaustedReason({ trialing: false, payg: { active: true, offReason: null }, room })).toBe("max_debt");
    expect(exhaustedReason({ trialing: false, payg: { active: true, offReason: null }, room: { room: 0, limitedBy: "monthly_limit" } })).toBe("monthly_limit");
  });

  it("has no route that starts a charge (D19)", () => {
    const methods = Object.getOwnPropertyNames(BillingPayments.prototype);
    expect(methods.filter((name) => /pay(Now|Debt|Invoice)|charge(Now|Debt)/i.test(name))).toEqual([]);
    expect(Object.keys(payments).filter((name) => /payNow/i.test(name))).toEqual([]);
  });
});

describe("pay-as-you-go in the ledger", () => {
  it("stops at the maximum debt", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u");
    const ctx = context({ payg: true });
    const first = await billing.ledger.reserve(reserveInput(account.id, 1_000, { context: ctx }));
    await billing.ledger.settle({ reservationId: first.reservation.id, credits: 1_000, idempotencyKey: "job:a:settle", context: ctx });
    await expect(billing.ledger.reserve(reserveInput(account.id, 1, { context: ctx }))).rejects.toMatchObject({ details: { reason: "max_debt", available: 0 } });
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("stops at the monthly limit and resets at the window edge", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u");
    await billing.settings.setPayg({ accountId: account.id, monthlyLimitCents: 500 });
    const anchor = billing.clock.now();
    const ctx = context({ payg: true, windowAnchor: anchor });
    const first = await billing.ledger.reserve(reserveInput(account.id, 500, { context: ctx }));
    await billing.ledger.settle({ reservationId: first.reservation.id, credits: 500, idempotencyKey: "job:m:settle", context: ctx });
    await billing.ledger.recordDebtPaid({ accountId: account.id, invoiceId: "in_m", credits: 500 });
    await expect(billing.ledger.reserve(reserveInput(account.id, 1, { context: ctx }))).rejects.toMatchObject({ details: { reason: "monthly_limit" } });
    billing.clock.set(new Date(Date.UTC(2026, 11, 13, 12))); // one month after the anchor
    await expect(billing.ledger.reserve(reserveInput(account.id, 500, { context: ctx }))).resolves.toMatchObject({ replayed: false });
  });

  it("is off during the trial: runs stop when the trial credits run out", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "trial");
    const trialEnd = new Date(billing.clock.now().getTime() + 7 * 86_400_000);
    await billing.setSubscription(subscriptionFixture({ accountId: account.id, status: "trialing", trialEnd, currentPeriodEnd: trialEnd, billingAnchor: trialEnd }));
    const view = await billing.entitlements.forAccount(account.id);
    expect(view.creditContext).toMatchObject({ trialing: true, allowance: null, trialGrant: { credits: 1_000 } });
    const balance = await billing.ledger.balance(account.id, view.creditContext);
    expect(balance).toMatchObject({ granted: 1_000, debtRoom: 0, payg: { active: false, offReason: "trial" } });
    await expect(billing.ledger.reserve(reserveInput(account.id, 1_001, { context: view.creditContext }))).rejects.toMatchObject({ details: { reason: "trial_credits" } });
  });

  it("writes a refund adjustment without bringing the debt back", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u");
    await billing.ledger.recordAdjustment({ accountId: account.id, idempotencyKey: "refund:in_1", metadata: { refundedCredits: 500 } });
    await billing.ledger.recordAdjustment({ accountId: account.id, idempotencyKey: "refund:in_1", metadata: { refundedCredits: 500 } });
    const entries = billing.store.allLedgerEntries(account.id).filter((entry) => entry.kind === "adjust");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.credits).toBe(0);
  });
});
