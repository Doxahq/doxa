import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { checkLedgerInvariant } from "../src/testing";
import { accountWithCredits, createTestBilling } from "./helpers/fixtures";

/**
 * Spec 20.1: random streams of call costs, with up to 24 calls in flight.
 * The worker starts no new call after a stop; calls in flight finish.
 */
describe("metering properties", () => {
  const run = async (input: { credits: number; payg: boolean; batches: number[][]; cap: number | null }) => {
    const billing = createTestBilling();
    const account = await accountWithCredits(billing, input.credits);
    if (input.payg) {
      await billing.store.insertOverride(
        { accountId: account.id, key: "ai.payg", value: true, reason: "test", startsAt: null, expiresAt: null, createdBy: "test" },
        billing.clock.now(),
      );
    }
    const subject = { kind: "job", id: "prop" };
    const opened = await billing.meter
      .open({ accountId: account.id, actionKey: "generation.run", subject, ...(input.cap === null ? {} : { capCredits: input.cap }) })
      .catch(() => null);
    if (!opened || opened.kind !== "reserved") return null;
    let call = 0;
    for (const batch of input.batches) {
      if (!(await billing.meter.status(subject)).active) break;
      await Promise.all(batch.map((micros) => billing.meter.accrue({ subject, callId: `c${call++}`, costUsd: micros / 1_000_000 })));
    }
    const finalHold = (await billing.store.findReservationBySubject("job", "prop"))!;
    const result = await billing.meter.settle({ subject, outcome: "succeeded" });
    const view = await billing.entitlements.forAccount(account.id);
    const balance = await billing.ledger.balance(account.id, view.creditContext);
    const invariant = await checkLedgerInvariant(billing.store, account.id);
    return { result, finalHold, balance, invariant };
  };

  const cost = fc.integer({ min: 0, max: 200_000 }); // up to $0.20 a call = 60 credits

  it("never charges above the cap, never goes negative, and settled + released equals the hold", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4_000 }),
        fc.boolean(),
        fc.array(fc.array(cost, { minLength: 1, maxLength: 24 }), { minLength: 1, maxLength: 12 }),
        fc.option(fc.integer({ min: 50, max: 5_000 }), { nil: null }),
        async (credits, payg, batches, cap) => {
          const outcome = await run({ credits, payg, batches, cap });
          if (!outcome) return;
          const { result, finalHold, balance, invariant } = outcome;
          expect(result.charged).toBeLessThanOrEqual(finalHold.capCredits);
          expect(balance.available).toBeGreaterThanOrEqual(0);
          expect(invariant.holds).toBe(true);
          if (result.charged <= finalHold.amount) expect(result.charged + result.released).toBe(finalHold.amount);
          if (result.shortfall > 0) {
            expect(finalHold.stopReason).not.toBeNull();
            expect(result.price).toBeGreaterThan(finalHold.amount);
          }
        },
      ),
      { numRuns: 60, seed: 20261113 },
    );
  });

  it("has no shortfall with one call in flight that costs at most the margin", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 450, max: 3_000 }),
        fc.array(cost.map((micros) => [micros]), { minLength: 5, maxLength: 40 }),
        async (credits, batches) => {
          const outcome = await run({ credits, payg: false, batches, cap: null });
          if (!outcome) return;
          expect(outcome.result.shortfall).toBe(0);
        },
      ),
      { numRuns: 40, seed: 7 },
    );
  });
});
