import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CreditsExhaustedError } from "../src/index";
import { checkLedgerInvariant } from "../src/testing";
import { accountWithCredits, context, createTestBilling, reserveInput } from "./helpers/fixtures";

type Op =
  | { kind: "grant"; amount: number }
  | { kind: "reserve"; amount: number }
  | { kind: "settle"; pick: number; credits: number }
  | { kind: "release"; pick: number }
  | { kind: "replay" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("grant" as const), amount: fc.integer({ min: 0, max: 800 }) }),
  fc.record({ kind: fc.constant("reserve" as const), amount: fc.integer({ min: 0, max: 900 }) }),
  fc.record({ kind: fc.constant("settle" as const), pick: fc.nat(), credits: fc.integer({ min: 0, max: 1_200 }) }),
  fc.record({ kind: fc.constant("release" as const), pick: fc.nat() }),
  fc.constant({ kind: "replay" as const }),
);

const MAX_DEBT = 1_000;

/** Spec 20.1: random operations against a simple reference model. */
describe("ledger model test", () => {
  it("matches the reference model and keeps every invariant", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.array(opArb, { minLength: 10, maxLength: 40 }), async (payg, ops) => {
        const billing = createTestBilling();
        const account = await accountWithCredits(billing, 0);
        const ctx = context({ payg });
        const model = { granted: 0, debt: 0, holds: new Map<string, number>() };
        const room = () => (payg ? Math.max(0, MAX_DEBT - model.debt) : 0);
        const heldSum = () => [...model.holds.values()].reduce((sum, value) => sum + value, 0);
        const reservations: string[] = [];
        let last: (() => Promise<void>) | null = null;
        let grantCount = 0;

        for (const op of ops) {
          if (op.kind === "grant") {
            const sourceRef = `promo:${grantCount++}`;
            const action = () => billing.ledger.grant({ accountId: account.id, kind: "promo", amount: op.amount, sourceRef, expiresAt: null }).then(() => undefined);
            await action();
            model.granted += op.amount;
            last = action;
          } else if (op.kind === "reserve") {
            const input = reserveInput(account.id, op.amount, { context: ctx });
            const available = model.granted + room() - heldSum();
            const action = async () => {
              await billing.ledger.reserve(input).catch((error: unknown) => {
                if (!(error instanceof CreditsExhaustedError)) throw error;
              });
            };
            await action();
            const stored = await billing.store.findReservationByKey(input.idempotencyKey);
            expect(Boolean(stored)).toBe(op.amount <= available);
            if (stored) {
              model.holds.set(stored.id, op.amount);
              reservations.push(stored.id);
            }
            last = action;
          } else if (op.kind === "settle" || op.kind === "release") {
            if (reservations.length === 0) continue;
            const id = reservations[op.pick % reservations.length]!;
            if (op.kind === "settle") {
              const action = () => billing.ledger.settle({ reservationId: id, credits: op.credits, idempotencyKey: `settle:${id}`, context: ctx }).then(() => undefined);
              const hold = model.holds.get(id);
              const result = await billing.ledger.settle({ reservationId: id, credits: op.credits, idempotencyKey: `settle:${id}`, context: ctx });
              if (hold !== undefined) {
                const payable = Math.max(0, model.granted + room() - (heldSum() - hold));
                const charged = Math.min(op.credits, payable);
                const fromGrants = Math.min(charged, model.granted);
                expect(result).toMatchObject({ outcome: "settled", charged, fromGrants, debt: charged - fromGrants });
                if (charged <= hold) expect(result.charged + result.released).toBe(hold);
                model.granted -= fromGrants;
                model.debt += charged - fromGrants;
                model.holds.delete(id);
              } else {
                expect(result.outcome === "replayed" || result.outcome === "not_held").toBe(true);
              }
              last = action;
            } else {
              const action = () => billing.ledger.release({ reservationId: id, reason: "model" }).then(() => undefined);
              await action();
              model.holds.delete(id);
              last = action;
            }
          } else if (last) {
            await last(); // a replayed key changes nothing ... except a grant replay, which is also a no-op
          }

          const balance = await billing.ledger.balance(account.id, ctx);
          expect(balance.available).toBeGreaterThanOrEqual(0);
          expect(balance).toMatchObject({ granted: model.granted, openDebt: model.debt, held: heldSum(), available: model.granted + room() - heldSum() });
          expect((await checkLedgerInvariant(billing.store, account.id)).holds).toBe(true);
        }
      }),
      { numRuns: 60, seed: 1113 },
    );
  });
});
