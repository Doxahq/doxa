import { describe, expect, it } from "vitest";

import { CreditsExhaustedError, DAY_MS } from "../src/index";
import { checkLedgerInvariant } from "../src/testing";
import { accountWithCredits, context, createTestBilling, reserveInput } from "./helpers/fixtures";

describe("credit ledger (memory store)", () => {
  it("grants once for each source ref", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 0);
    const first = await billing.ledger.grant({ accountId: account.id, kind: "promo", amount: 100, sourceRef: "promo:a", expiresAt: null });
    const again = await billing.ledger.grant({ accountId: account.id, kind: "promo", amount: 100, sourceRef: "promo:a", expiresAt: null });
    expect(again).toEqual({ grant: first.grant, replayed: true });
    expect((await billing.ledger.balance(account.id, context())).available).toBe(100);
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("reserves, refuses more than available, and replays a reservation by key", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 500);
    const input = reserveInput(account.id, 300);
    const first = await billing.ledger.reserve(input);
    expect((await billing.ledger.reserve(input)).replayed).toBe(true);
    expect((await billing.ledger.balance(account.id, context())).available).toBe(200);
    await expect(billing.ledger.reserve(reserveInput(account.id, 201))).rejects.toMatchObject({
      details: { available: 200, needed: 201, reason: "payg_off" },
    });
    expect(first.reservation.status).toBe("held");
  });

  it("extends in steps up to the cap and the available credits", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 1_000);
    const { reservation } = await billing.ledger.reserve(reserveInput(account.id, 400, { capCredits: 800 }));
    const step = await billing.ledger.extend({ reservationId: reservation.id, accountId: account.id, by: 250, context: context() });
    expect(step.added).toBe(250);
    const capped = await billing.ledger.extend({ reservationId: reservation.id, accountId: account.id, by: 250, context: context() });
    expect(capped.added).toBe(150);
    expect(capped.reservation.amount).toBe(800);
    const other = await billing.ledger.reserve(reserveInput(account.id, 150));
    const none = await billing.ledger.extend({ reservationId: other.reservation.id, accountId: account.id, by: 250, context: context() });
    expect(none.added).toBe(50);
  });

  it.each([
    ["below", 120],
    ["at", 300],
    ["above", 450],
  ])("settles %s the hold", async (_label, credits) => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 1_000);
    const { reservation } = await billing.ledger.reserve(reserveInput(account.id, 300));
    const result = await billing.ledger.settle({ reservationId: reservation.id, credits, idempotencyKey: `job:${reservation.subjectId}:settle`, context: context() });
    expect(result).toMatchObject({ outcome: "settled", charged: credits, shortfall: 0, released: Math.max(0, 300 - credits) });
    const balance = await billing.ledger.balance(account.id, context());
    expect(balance).toMatchObject({ held: 0, available: 1_000 - credits });
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("replays a settle and refuses a second settle or release of the same hold", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 1_000);
    const { reservation } = await billing.ledger.reserve(reserveInput(account.id, 300));
    const key = `job:${reservation.subjectId}:settle`;
    const first = await billing.ledger.settle({ reservationId: reservation.id, credits: 200, idempotencyKey: key, context: context() });
    const replay = await billing.ledger.settle({ reservationId: reservation.id, credits: 999, idempotencyKey: key, context: context() });
    expect(replay).toEqual({ ...first, outcome: "replayed" });
    expect(await billing.ledger.release({ reservationId: reservation.id, reason: "test" })).toEqual({ outcome: "not_held", released: 0 });
    expect((await billing.ledger.balance(account.id, context())).available).toBe(800);
  });

  it("lets only one of a concurrent settle and release win", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 1_000);
    const { reservation } = await billing.ledger.reserve(reserveInput(account.id, 300));
    const [settled, released] = await Promise.all([
      billing.ledger.settle({ reservationId: reservation.id, credits: 250, idempotencyKey: "job:x:settle", context: context() }),
      billing.ledger.release({ reservationId: reservation.id, reason: "test" }),
    ]);
    expect([settled.outcome, released.outcome].filter((outcome) => outcome === "settled" || outcome === "released")).toHaveLength(1);
  });

  it("releases a hold idempotently", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 1_000);
    const { reservation } = await billing.ledger.reserve(reserveInput(account.id, 300));
    expect(await billing.ledger.release({ reservationId: reservation.id, reason: "job gone" })).toEqual({ outcome: "released", released: 300 });
    expect(await billing.ledger.release({ reservationId: reservation.id, reason: "job gone" })).toEqual({ outcome: "not_held", released: 0 });
    expect((await billing.ledger.balance(account.id, context())).available).toBe(1_000);
  });

  it("revokes what is left of a grant after partial use", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 0);
    const { grant } = await billing.ledger.grant({ accountId: account.id, kind: "promo", amount: 500, sourceRef: "promo:r", expiresAt: null });
    const { reservation } = await billing.ledger.reserve(reserveInput(account.id, 200));
    await billing.ledger.settle({ reservationId: reservation.id, credits: 200, idempotencyKey: "job:r:settle", context: context() });
    expect(await billing.ledger.revoke({ accountId: account.id, grantId: grant.id, reason: "fraud" })).toEqual({ revoked: 300 });
    expect(await billing.ledger.revoke({ accountId: account.id, grantId: grant.id, reason: "fraud" })).toEqual({ revoked: 0 });
    expect((await billing.ledger.balance(account.id, context())).available).toBe(0);
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("debits the grant that expires first, and handles expiry during a hold with a shortfall", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 0);
    const late = await billing.ledger.grant({ accountId: account.id, kind: "promo", amount: 300, sourceRef: "promo:late", expiresAt: new Date(billing.clock.now().getTime() + 10 * DAY_MS) });
    const soon = await billing.ledger.grant({ accountId: account.id, kind: "promo", amount: 200, sourceRef: "promo:soon", expiresAt: new Date(billing.clock.now().getTime() + 1 * DAY_MS) });
    const never = await billing.ledger.grant({ accountId: account.id, kind: "adjustment", amount: 100, sourceRef: "adj:never", expiresAt: null });

    const first = await billing.ledger.reserve(reserveInput(account.id, 250));
    await billing.ledger.settle({ reservationId: first.reservation.id, credits: 250, idempotencyKey: "job:a:settle", context: context() });
    const grants = new Map((await billing.store.listGrants(account.id)).map((grant) => [grant.id, grant.remaining]));
    expect([grants.get(soon.grant.id), grants.get(late.grant.id), grants.get(never.grant.id)]).toEqual([0, 250, 100]);

    const held = await billing.ledger.reserve(reserveInput(account.id, 300));
    billing.clock.advance(11 * DAY_MS); // the 250 left of `late` expire during the hold
    const result = await billing.ledger.settle({ reservationId: held.reservation.id, credits: 300, idempotencyKey: "job:b:settle", context: context() });
    expect(result).toMatchObject({ charged: 100, shortfall: 200 });
    const entries = billing.store.allLedgerEntries(account.id);
    expect(entries.filter((entry) => entry.kind === "expire").map((entry) => entry.credits)).toEqual([-250]);
    expect(entries.find((entry) => entry.kind === "shortfall")?.metadata).toEqual({ missingCredits: 200 });
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("uses grants before debt, and writes a usage report for the debt in the same settle", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 100);
    const paygContext = context({ payg: true });
    const { reservation } = await billing.ledger.reserve(reserveInput(account.id, 400, { context: paygContext }));
    const result = await billing.ledger.settle({ reservationId: reservation.id, credits: 350, idempotencyKey: "job:d:settle", context: paygContext });
    expect(result).toMatchObject({ fromGrants: 100, debt: 250, shortfall: 0 });
    expect(billing.store.allUsageReports(account.id)).toMatchObject([{ identifier: "job:d:settle", credits: 250, reportedAt: null }]);
    const balance = await billing.ledger.balance(account.id, paygContext);
    expect(balance).toMatchObject({ granted: 0, openDebt: 250, debtRoom: 750, available: 750 });
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("refuses with CreditsExhaustedError once the floor is reached", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 0);
    await expect(billing.ledger.reserve(reserveInput(account.id, 1))).rejects.toBeInstanceOf(CreditsExhaustedError);
    await expect(billing.ledger.reserve(reserveInput(account.id, 1, { context: context({ trialing: true }) }))).rejects.toMatchObject({
      details: { reason: "trial_credits" },
    });
  });

  it("ensures the allowance grant once per window and expires it at the window end", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 0);
    const anchor = billing.clock.now();
    const withAllowance = { ...context({ windowAnchor: anchor }), allowance: { anchor, monthlyCredits: 5_000 } };
    await billing.ledger.ensureAllowance(account.id, withAllowance);
    await billing.ledger.ensureAllowance(account.id, withAllowance);
    expect((await billing.ledger.balance(account.id, withAllowance)).available).toBe(5_000);
    billing.clock.advance(31 * DAY_MS);
    const next = await billing.ledger.balance(account.id, withAllowance);
    expect(next.available).toBe(5_000);
    const grants = await billing.store.listGrants(account.id);
    expect(grants.map((grant) => [grant.kind, grant.remaining])).toEqual([
      ["allowance", 0],
      ["allowance", 5_000],
    ]);
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("ends the old allowance when the anchor moves (monthly to yearly switch)", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 0);
    const anchor = billing.clock.now();
    const before = { ...context({ windowAnchor: anchor }), allowance: { anchor, monthlyCredits: 5_000 } };
    await billing.ledger.ensureAllowance(account.id, before);
    billing.clock.advance(10 * DAY_MS);
    const switchedAt = billing.clock.now();
    const after = { ...context({ windowAnchor: switchedAt }), allowance: { anchor: switchedAt, monthlyCredits: 5_000 } };
    expect((await billing.ledger.balance(account.id, after)).available).toBe(5_000);
    expect(billing.store.allLedgerEntries(account.id).filter((entry) => entry.kind === "expire")).toHaveLength(1);
  });

  it("clears only the paid invoice's credits, once", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 0);
    const paygContext = context({ payg: true });
    const { reservation } = await billing.ledger.reserve(reserveInput(account.id, 700, { context: paygContext }));
    await billing.ledger.settle({ reservationId: reservation.id, credits: 700, idempotencyKey: "job:p:settle", context: paygContext });
    expect(await billing.ledger.recordDebtPaid({ accountId: account.id, invoiceId: "in_1", credits: 500 })).toEqual({ cleared: 500, replayed: false });
    expect(await billing.ledger.recordDebtPaid({ accountId: account.id, invoiceId: "in_1", credits: 500 })).toEqual({ cleared: 500, replayed: true });
    expect((await billing.ledger.balance(account.id, paygContext)).openDebt).toBe(200);
    expect(await billing.ledger.recordDebtPaid({ accountId: account.id, invoiceId: "in_2", credits: 900 })).toEqual({ cleared: 200, replayed: false });
    expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
  });

  it("lets exactly 16 of 50 parallel reservations of 300 succeed on 5,000 (spec 20.2)", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 5_000);
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => billing.ledger.reserve(reserveInput(account.id, 300))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(16);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof CreditsExhaustedError)).toHaveLength(34);
    expect((await billing.ledger.balance(account.id, context())).available).toBe(200);
  });

  it("rolls back every write of a failed transaction", async () => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, 100);
    await expect(
      billing.store.withAccountLock(account.id, billing.clock.now(), async (tx) => {
        await tx.insertGrant({ kind: "promo", amount: 50, startsAt: tx.now, expiresAt: null, sourceRef: "promo:rollback" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await billing.store.listGrants(account.id)).map((grant) => grant.sourceRef)).not.toContain("promo:rollback");
  });
});
