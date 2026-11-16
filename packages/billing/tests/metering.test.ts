import { describe, expect, it } from "vitest";

import {
  CreditsExhaustedError,
  DOXA_CATALOG,
  defineCatalog,
  estimateRun,
  marginFor,
  meterPricingFor,
  parseUsd,
  usageCredits,
  type Catalog,
} from "../src/index";
import { checkLedgerInvariant, insertLegacyHeldReservation, subscriptionFixture } from "../src/testing";
import { accountWithCredits, createTestBilling } from "./helpers/fixtures";
import { paidProAccount, runJob } from "./helpers/pro";

const job = (id: string) => ({ kind: "job", id });

function catalogWithMarkup(markup: number): Catalog {
  return defineCatalog({ ...DOXA_CATALOG, usage: { ...DOXA_CATALOG.usage, markup } });
}

describe("price formula", () => {
  it("is base + ceil(model cost × markup × 100)", () => {
    expect(usageCredits(parseUsd(0.72)!, 300, 1)).toBe(216);
    expect(usageCredits(parseUsd("1.00")!, 300, 1)).toBe(300);
    expect(usageCredits(parseUsd("0.000001")!, 300, 1)).toBe(1);
    expect(usageCredits(parseUsd(0)!, 300, 1)).toBe(0);
  });

  it("parses exact decimals and exponents, rounding sub-picodollar digits up", () => {
    expect(parseUsd(1e-7)).toBe(100_000n);
    expect(parseUsd("0.0000000000001")).toBe(1n);
    expect(parseUsd(null)).toBeNull();
    expect(parseUsd(-1)).toBeNull();
    expect(parseUsd("abc")).toBeNull();
  });
});

describe("credit meter", () => {
  async function setup(credits: number, catalog?: Catalog) {
    const billing = createTestBilling(catalog ? { catalog } : {});
    const account = await accountWithCredits(billing, credits);
    return { billing, account };
  }

  it("rounds once at settle: 1,000 calls of $0.00001 cost 1 credit at markup 1", async () => {
    const { billing, account } = await setup(2_000, catalogWithMarkup(1));
    await billing.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject: job("j1") });
    for (let call = 0; call < 1_000; call += 1) await billing.meter.accrue({ subject: job("j1"), callId: `c${call}`, costUsd: 0.00001 });
    const result = await billing.meter.settle({ subject: job("j1"), outcome: "no_change" });
    expect(result.charged).toBe(1);
  });

  it("opens with base + min(estimate, cap − base) and charges a 50-page generation 266 credits", async () => {
    const { billing, account } = await setup(5_000);
    const opened = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("g1") });
    expect(opened).toMatchObject({ kind: "reserved", capCredits: 3_000, reservation: { amount: 450 } });
    await billing.meter.accrue({ subject: job("g1"), callId: "a", costUsd: 0.5 });
    await billing.meter.accrue({ subject: job("g1"), callId: "b", costUsd: "0.22" });
    const result = await billing.meter.settle({ subject: job("g1"), outcome: "succeeded" });
    expect(result).toMatchObject({ charged: 266, price: 266, outcome: "settled" });
    const entries = billing.store.allLedgerEntries(account.id);
    const head = entries.find((entry) => entry.idempotencyKey === "job:g1:settle#0");
    expect(head?.metadata).toMatchObject({ modelCostUsd: "0.720000000000", markup: 3, baseCredits: 50, capCredits: 3_000, outcome: "succeeded", priceTableHash: "test-price-table" });
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it.each([
    ["generation.run", "succeeded", 50 + 30],
    ["generation.run", "stopped", 50 + 30],
    ["generation.run", "cancelled", 50 + 30],
    ["generation.run", "failed", 0],
    ["doxabot.run", "pages_changed", 20 + 30],
    ["doxabot.run", "no_change", 30],
    ["doxabot.run", "superseded", 30],
    ["doxabot.run", "stopped", 20 + 30],
    ["doxabot.run", "cancelled", 20 + 30],
    ["doxabot.run", "failed", 0],
  ] as const)("charges %s outcome %s %d credits", async (actionKey, outcome, credits) => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey, subject: job("r") });
    await billing.meter.accrue({ subject: job("r"), callId: "c1", costUsd: 0.1 });
    expect((await billing.meter.settle({ subject: job("r"), outcome })).charged).toBe(credits);
  });

  it("refuses an outcome without a charge rule", async () => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("x") });
    await expect(billing.meter.settle({ subject: job("x"), outcome: "no_change" })).rejects.toMatchObject({ code: "unknown_outcome" });
  });

  it("clamps the charge at the cap", async () => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject: job("cap"), capCredits: 500 });
    await billing.meter.accrue({ subject: job("cap"), callId: "big", costUsd: 5 });
    expect((await billing.meter.settle({ subject: job("cap"), outcome: "pages_changed" })).charged).toBe(500);
  });

  it("clamps a requested cap to [minCap, maxCap] and uses the account cap", async () => {
    const { billing, account } = await setup(10_000);
    const huge = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("h"), capCredits: 99_999 });
    expect(huge).toMatchObject({ capCredits: 10_000 });
    const tiny = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("t"), capCredits: 60 });
    expect(tiny).toMatchObject({ capCredits: 1_000 });
    await billing.settings.setCap({ accountId: account.id, actionKey: "generation.run", capCredits: 1_500 });
    expect(await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("k") })).toMatchObject({ capCredits: 1_500 });
  });

  it("refuses a cap below minCap: 1,000 for a generation, 500 for a Doxabot run", async () => {
    const { billing, account } = await setup(10_000);
    const set = (actionKey: "generation.run" | "doxabot.run", capCredits: number) =>
      billing.settings.setCap({ accountId: account.id, actionKey, capCredits });
    await expect(set("generation.run", 999)).rejects.toMatchObject({ code: "cap_out_of_range" });
    await expect(set("generation.run", 350)).rejects.toMatchObject({ code: "cap_out_of_range" });
    await expect(set("doxabot.run", 499)).rejects.toMatchObject({ code: "cap_out_of_range" });
    await set("generation.run", 1_000);
    await set("doxabot.run", 500);
  });

  it("a cap saved below minCap before the rule runs at minCap", async () => {
    const { billing, account } = await setup(10_000);
    // A cap that the store kept from before the minimum existed.
    await billing.store.withAccountLock(account.id, new Date(), (tx) => tx.updateAccount({ actionCaps: { "generation.run": 280 } }));
    expect(await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("old") })).toMatchObject({ capCredits: 1_000 });
  });

  it("extends the hold in steps of 250 when the headroom falls below the margin", async () => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("e") });
    // hold 450, margin 300: 0.34 USD = 102 credits -> price 152, headroom 298 < 300
    const result = await billing.meter.accrue({ subject: job("e"), callId: "c1", costUsd: 0.34 });
    expect(result).toMatchObject({ status: "accrued", stop: null, priceSoFar: 152 });
    const reservation = await billing.store.findReservationBySubject("job", "e");
    expect(reservation?.amount).toBe(700);
    expect(billing.counters.some((counter) => counter.name === "credits.extend")).toBe(true);
  });

  it("writes one stop reason when an extension fails, and isJobActive reports it", async () => {
    const { billing, account } = await setup(500);
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("s") });
    expect(await billing.meter.status(job("s"))).toEqual({ active: true, stopReason: null });
    // price 230, headroom 220: the extension adds the last 50 credits, 270 < margin 300.
    const first = await billing.meter.accrue({ subject: job("s"), callId: "c1", costUsd: 0.6 });
    expect(first.stop).toBe("credits_exhausted");
    const second = await billing.meter.accrue({ subject: job("s"), callId: "c2", costUsd: 0.1 });
    expect(second).toMatchObject({ status: "accrued", stop: "credits_exhausted" });
    expect(await billing.meter.status(job("s"))).toEqual({ active: false, stopReason: "credits_exhausted" });
    expect(billing.counters.filter((counter) => counter.name === "credits.stop")).toHaveLength(1);
  });

  it("stops with credit_cap when the hold reaches the cap", async () => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject: job("c"), capCredits: 500 });
    // price 20 + 450 = 470: the hold grows to the cap, 30 left < margin 100.
    const result = await billing.meter.accrue({ subject: job("c"), callId: "c1", costUsd: 1.5 });
    expect(result.stop).toBe("credit_cap");
  });

  it("one large call grows the hold enough to keep the margin, not by one step only", async () => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("large") });
    // hold 450; 1.5 USD = 450 credits: price 500. One step (700) leaves 200 < margin 300.
    const result = await billing.meter.accrue({ subject: job("large"), callId: "c1", costUsd: 1.5 });
    expect(result).toMatchObject({ stop: null, priceSoFar: 500 });
    expect((await billing.store.findReservationBySubject("job", "large"))?.amount).toBe(800);
  });

  it("adds nothing for a replayed call ID", async () => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject: job("d") });
    await billing.meter.accrue({ subject: job("d"), callId: "same", costUsd: 0.1 });
    const replay = await billing.meter.accrue({ subject: job("d"), callId: "same", costUsd: 0.1 });
    expect(replay.status).toBe("duplicate");
    expect((await billing.meter.settle({ subject: job("d"), outcome: "no_change" })).charged).toBe(30);
  });

  it("does not charge a usage record that arrives after the settle", async () => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject: job("l") });
    await billing.meter.settle({ subject: job("l"), outcome: "no_change" });
    const late = await billing.meter.accrue({ subject: job("l"), callId: "late", costUsd: 1 });
    expect(late.status).toBe("late");
    expect(billing.counters.some((counter) => counter.name === "credits.late_usage")).toBe(true);
    expect((await billing.meter.settle({ subject: job("l"), outcome: "no_change" })).outcome).toBe("replayed");
  });

  it("adds 0 for a null cost and counts credits.unpriced_model", async () => {
    const { billing, account } = await setup(5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject: job("n") });
    expect((await billing.meter.accrue({ subject: job("n"), callId: "c1", costUsd: null })).status).toBe("unpriced");
    expect(billing.counters.some((counter) => counter.name === "credits.unpriced_model")).toBe(true);
    expect((await billing.meter.settle({ subject: job("n"), outcome: "pages_changed" })).charged).toBe(20);
  });

  it("refuses admission with 402 details when the first hold does not fit", async () => {
    const { billing, account } = await setup(100);
    const error = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("z") }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CreditsExhaustedError);
    expect(error).toMatchObject({ details: { available: 100, needed: 450, reason: "payg_off" } });
  });

  it("does not meter a free action or a plan that does not enforce credits", async () => {
    const { billing, account } = await setup(0);
    expect(await billing.meter.open({ accountId: account.id, actionKey: "mcp.tool_call", subject: job("m") })).toEqual({ kind: "not_metered", reason: "free_action" });
    const selfHosted = createTestBilling({ defaultPlan: "self_hosted" });
    const other = await selfHosted.accounts.accountForOwner("user", "u");
    expect(await selfHosted.meter.open({ accountId: other.id, actionKey: "generation.run", subject: job("sh") })).toEqual({
      kind: "not_metered",
      reason: "credits_not_enforced",
    });
  });

  it("uses the monthly allowance of a Pro subscription", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "pro_user");
    await billing.setSubscription(subscriptionFixture({ accountId: account.id }));
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("pro") });
    const view = await billing.entitlements.forAccount(account.id);
    expect((await billing.ledger.balance(account.id, view.creditContext)).available).toBe(5_000 + 1_000 - 450);
  });
});

describe("estimate", () => {
  const pricing = meterPricingFor(DOXA_CATALOG, "generation.run")!;

  it("uses the default without history", () => {
    expect(estimateRun({ pricing, capCredits: 3_000, recentUsageCredits: [] })).toEqual({ estimateCredits: 400, low: 317, high: 450, cap: 3_000, source: "default" });
  });

  it("uses 1.5 × the median of the last 5 runs, clamped to the cap", () => {
    expect(estimateRun({ pricing, capCredits: 3_000, recentUsageCredits: [200, 100, 300, 250, 150, 9_999] })).toMatchObject({ estimateCredits: 300, low: 250, high: 350, source: "history" });
    expect(estimateRun({ pricing, capCredits: 300, recentUsageCredits: [400] })).toMatchObject({ low: 300, high: 300 });
  });
});

describe("in-flight margin of a small cap", () => {
  const generation = meterPricingFor(DOXA_CATALOG, "generation.run")!;
  const doxabot = meterPricingFor(DOXA_CATALOG, "doxabot.run")!;

  it("is the action's margin, but at most a quarter of the cap", () => {
    expect(marginFor(generation, 3_000)).toBe(300);
    expect(marginFor(generation, 1_200)).toBe(300);
    expect(marginFor(generation, 1_199)).toBe(299);
    expect(marginFor(generation, 350)).toBe(87);
    expect(marginFor(doxabot, 500)).toBe(100);
    expect(marginFor(doxabot, 120)).toBe(30);
    // At the lowest caps: 1,000 and 500.
    expect(marginFor(generation, 1_000)).toBe(250);
  });

  // 2026-11-16: a generation with a cap of 280 stopped at its first model
  // call with 54 credits used, because the margin (300) was above the cap.
  // The margin rule holds for any cap, so this catalog allows a cap of 350.
  it("a run at a small cap does real work before it stops at the cap", async () => {
    const generationPricing = DOXA_CATALOG.actions["generation.run"].pricing;
    if (generationPricing.kind !== "metered") throw new Error("generation.run is metered");
    const catalog = defineCatalog({
      ...DOXA_CATALOG,
      actions: {
        ...DOXA_CATALOG.actions,
        "generation.run": { ...DOXA_CATALOG.actions["generation.run"], pricing: { ...generationPricing, minCap: 350 } },
      },
    });
    const billing = createTestBilling({ catalog });
    const account = await accountWithCredits(billing, 5_000);
    await billing.settings.setCap({ accountId: account.id, actionKey: "generation.run", capCredits: 350 });
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject: job("small") });
    const reservation = await billing.store.findReservationBySubject("job", "small");
    expect(reservation).toMatchObject({ amount: 350, capCredits: 350, inFlightMarginCredits: 87 });

    // 0.0133 USD = 4 credits: price 54, headroom 296.
    expect(await billing.meter.accrue({ subject: job("small"), callId: "c1", costUsd: 0.0133 })).toMatchObject({ stop: null, priceSoFar: 54 });
    // 0.7 USD = 210 credits: price 264, headroom 86 < 87, the hold is at the cap.
    expect(await billing.meter.accrue({ subject: job("small"), callId: "c2", costUsd: 0.7 })).toMatchObject({ stop: "credit_cap", priceSoFar: 264 });
    // A call in flight after the stop: the price stays at the cap.
    await billing.meter.accrue({ subject: job("small"), callId: "c3", costUsd: 0.5 });
    expect((await billing.meter.settle({ subject: job("small"), outcome: "stopped" })).charged).toBe(350);
  });
});

describe("a continued job (the same subject, a second admission)", () => {
  const subject = job("continued");
  const second = { idempotencyKey: "job:continued:reserve:resume-1" };

  async function stoppedFirstTry(credits = 5_000) {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, credits);
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0 });
    await billing.meter.accrue({ subject, callId: "a1", costUsd: 0.1 });
    const first = await billing.meter.settle({ subject, outcome: "stopped" });
    return { billing, account, first };
  }

  // 2026-11-16 review: two continues of one job raced. The one that lost
  // released the newest hold, which the running job used, and every later
  // call was counted as late and never charged.
  it("refuses a second continue while the first one holds credits; a replay of the first is fine", async () => {
    const { billing, account } = await stoppedFirstTry();
    const a = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, idempotencyKey: "job:continued:reserve:resume-a" });
    expect(a.kind).toBe("reserved");
    await expect(
      billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, idempotencyKey: "job:continued:reserve:resume-b" }),
    ).rejects.toMatchObject({ code: "reservation_in_use" });
    expect(await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, idempotencyKey: "job:continued:reserve:resume-a" }))
      .toMatchObject({ kind: "reserved", replayed: true });
    // Once A settles, a new continue can hold credits again.
    await billing.meter.settle({ subject, outcome: "stopped" });
    expect((await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, idempotencyKey: "job:continued:reserve:resume-c" })).kind)
      .toBe("reserved");
  });

  it("with two holds left from before that rule, usage, the stop check and the live meter use the held one", async () => {
    const { billing, account } = await stoppedFirstTry();
    const a = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, idempotencyKey: "job:continued:reserve:resume-a" });
    if (a.kind !== "reserved") throw new Error("continue A holds credits");
    billing.clock.advance(1_000);
    const b = await insertLegacyHeldReservation(billing.store, a.reservation, {
      idempotencyKey: "job:continued:reserve:resume-b",
      baseCredits: 0,
      amount: 450,
      at: billing.clock.now(),
    });
    await billing.meter.releaseReservation({ reservationId: b.id, reason: "admission_abandoned" });

    expect((await billing.meter.activeReservationOf(subject))?.id).toBe(a.reservation.id);
    expect(await billing.meter.accrue({ subject, callId: "after-race", costUsd: 1 })).toMatchObject({ status: "accrued", priceSoFar: 300 });
    expect(await billing.meter.status(subject)).toEqual({ active: true, stopReason: null });
    // The live meter shows the held try (300), not the released newer one (0).
    expect((await billing.meter.creditsOf(subject)).latestCredits).toBe(300);
    expect((await billing.meter.settle({ subject, outcome: "succeeded" })).charged).toBe(300);
  });

  it("charges the base fee once: the continue opens without it after a stopped try paid it", async () => {
    const { billing, account, first } = await stoppedFirstTry();
    expect(first.charged).toBe(50 + 30);
    const opened = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 200, ...second });
    // The first hold is min(estimate, cap), with no base.
    expect(opened).toMatchObject({ kind: "reserved", reservation: { baseCredits: 0, amount: 200 } });
    await billing.meter.accrue({ subject, callId: "b1", costUsd: 0.2 });
    expect((await billing.meter.settle({ subject, outcome: "succeeded" })).charged).toBe(60);
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("charges the base fee on the continue when the earlier try charged nothing (failed)", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0 });
    await billing.meter.accrue({ subject, callId: "a1", costUsd: 0.1 });
    expect((await billing.meter.settle({ subject, outcome: "failed" })).charged).toBe(0);
    const opened = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0, ...second });
    expect(opened).toMatchObject({ kind: "reserved", reservation: { baseCredits: 50 } });
  });

  it("charges the base fee on the continue when the earlier hold was released", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 5_000);
    const first = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0 });
    if (first.kind !== "reserved") throw new Error("expected a hold");
    await billing.meter.releaseReservation({ reservationId: first.reservation.id, reason: "admission_abandoned" });
    const opened = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0, ...second });
    expect(opened).toMatchObject({ kind: "reserved", reservation: { baseCredits: 50 } });
  });

  it("a replayed first admission keeps its base fee", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 5_000);
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0 });
    const replay = await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0 });
    expect(replay).toMatchObject({ kind: "reserved", replayed: true, reservation: { baseCredits: 50 } });
  });

  it("reads the job's credits over every try: settled charges plus the running price of the held try", async () => {
    const { billing, account } = await stoppedFirstTry();
    expect(await billing.meter.creditsOf(subject)).toEqual({ usedCredits: 80, latestCredits: 80, settledDebtCredits: 0 });
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0, ...second });
    // The continue starts at 0 (no base), so the job total does not go down.
    expect(await billing.meter.creditsOf(subject)).toEqual({ usedCredits: 80, latestCredits: 0, settledDebtCredits: 0 });
    await billing.meter.accrue({ subject, callId: "b1", costUsd: 0.2 });
    expect(await billing.meter.creditsOf(subject)).toEqual({ usedCredits: 140, latestCredits: 60, settledDebtCredits: 0 });
    expect(await billing.meter.creditsOf(job("never-opened"))).toEqual({ usedCredits: 0, latestCredits: 0, settledDebtCredits: 0 });
  });

  it("counts the pay-as-you-go part of the earlier tries from their debt entries", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    // Use most of the 5,000 monthly credits, so the next try runs into debt.
    await runJob(billing, account.id, "earlier", 16.5);
    await billing.meter.open({ accountId: account.id, actionKey: "generation.run", subject, estimateCredits: 0, capCredits: 5_000 });
    await billing.meter.accrue({ subject, callId: "a1", costUsd: 1 });
    const first = await billing.meter.settle({ subject, outcome: "stopped" });
    expect(first.debt).toBeGreaterThan(0);
    expect((await billing.meter.creditsOf(subject)).settledDebtCredits).toBe(first.debt);
  });
});
