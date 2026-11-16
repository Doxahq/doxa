import { describe, expect, it } from "vitest";

import type { ProviderEvent, RawWebhook } from "../src/provider/provider";
import { createTestBilling } from "../src/testing";
import { paidProAccount, runJob } from "./helpers/pro";

async function openDebt(billing: ReturnType<typeof createTestBilling>, accountId: string) {
  const view = await billing.entitlements.forAccount(accountId);
  return (await billing.ledger.balance(accountId, view.creditContext)).openDebt;
}

describe("pay-as-you-go webhooks", () => {
  it("collects a threshold invoice at once, clears its debt, and a replay does nothing", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    expect(billing.provider.usageState(customer)?.thresholdCents).toBe(500);
    expect((await billing.entitlements.forAccount(account.id)).entitlements.plan).toBe("pro");

    // Use the 5,000 allowance, then 600 credits of debt: 50 + ceil(x × 300).
    await runJob(billing, account.id, "j1", 16.5); // 50 + 4950 = 5000
    await runJob(billing, account.id, "j2", 1.83); // 50 + 549 = 599 -> all debt
    expect(await openDebt(billing, account.id)).toBe(599);

    await billing.payments.reportPendingUsage();
    const hooks = billing.provider.drainWebhooks();
    expect(hooks).toHaveLength(1);
    expect((await billing.webhooks.handle(hooks[0]!)).status).toBe(200);
    expect(await openDebt(billing, account.id)).toBe(0);
    const [invoice] = await billing.store.listPaygInvoices(account.id);
    expect(invoice).toMatchObject({ status: "paid", credits: 599, amountCents: 599, reason: "threshold" });

    // The provider also sent invoice.paid; and the created event may be replayed.
    for (const raw of [...billing.provider.drainWebhooks(), hooks[0]!]) expect((await billing.webhooks.handle(raw)).status).toBe(200);
    expect(await openDebt(billing, account.id)).toBe(0);
    expect(billing.store.allLedgerEntries(account.id).filter((entry) => entry.kind === "debt_paid")).toHaveLength(1);
  });

  it("turns pay-as-you-go off after a failed charge and on again after the invoice is paid", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    await runJob(billing, account.id, "j1", 16.5);
    await runJob(billing, account.id, "j2", 1.83);
    billing.provider.setCardFails(customer, true);
    await billing.payments.reportPendingUsage();
    await billing.deliverWebhooks();
    expect((await billing.store.getAccount(account.id))?.aiPausedReason).toBe("payment_failed");
    const view = await billing.entitlements.forAccount(account.id);
    expect((await billing.ledger.balance(account.id, view.creditContext)).payg).toEqual({ active: false, offReason: "payment_failed" });

    billing.provider.setCardFails(customer, false);
    const [failed] = await billing.store.listPaygInvoices(account.id);
    await billing.provider.collectThresholdInvoice(failed!.providerInvoiceId); // Smart Retries succeed
    await billing.deliverWebhooks();
    expect((await billing.store.getAccount(account.id))?.aiPausedReason).toBeNull();
    expect(await openDebt(billing, account.id)).toBe(0);
  });

  it("sweeps a small debt once a month and sets the threshold back", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    await runJob(billing, account.id, "j1", 16.5);
    await runJob(billing, account.id, "j2", 0.4); // 50 + 120 = 170 credits of debt
    await billing.payments.reportPendingUsage();
    expect(billing.provider.drainWebhooks()).toEqual([]); // below the $5 threshold
    expect(await billing.payments.runMonthlySweep(account.id)).toEqual({ sweptCredits: 170, ran: true });
    await billing.deliverWebhooks();
    expect(await openDebt(billing, account.id)).toBe(0);
    // The created event (paid at once) and the paid event each set it back:
    // the reset runs on a replay too, so a failed reset is tried again.
    expect(billing.provider.thresholdChanges.map((change) => change.amountCents)).toEqual([500, 170, 500, 500]);
    const invoices = await billing.store.listPaygInvoices(account.id);
    expect(invoices).toMatchObject([{ status: "paid", credits: 171, reason: "sweep" }]);
  });

  // 2026-11-16 review: the debt payment was recorded before the reset, so
  // the provider's retry counted as a replay and skipped the reset.
  it("a sweep whose threshold reset failed sets it back on the provider's retry", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    await runJob(billing, account.id, "j1", 16.5);
    await runJob(billing, account.id, "j2", 0.4);
    await billing.payments.reportPendingUsage();
    billing.provider.drainWebhooks();
    await billing.payments.runMonthlySweep(account.id);

    const hooks = billing.provider.drainWebhooks();
    billing.provider.failNext("setChargeThreshold");
    const first = await Promise.all(hooks.map((raw) => billing.webhooks.handle(raw)));
    expect(first.map((result) => result.status)).toContain(500);
    expect(await openDebt(billing, account.id)).toBe(0);
    expect(billing.provider.thresholdChanges.map((change) => change.amountCents)).toEqual([500, 170]);

    // The provider sends the events again.
    for (const raw of [...hooks, ...billing.provider.drainWebhooks()]) expect((await billing.webhooks.handle(raw)).status).toBe(200);
    expect(billing.provider.thresholdChanges.map((change) => change.amountCents).at(-1)).toBe(500);
    expect(billing.store.allLedgerEntries(account.id).filter((entry) => entry.kind === "debt_paid")).toHaveLength(1);
  });

  // 2026-11-16 review: a failure event that came after the paid event paused
  // AI use, although the invoice stayed paid.
  it("a late failure event of a paid invoice does not pause the account", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    await runJob(billing, account.id, "j1", 16.5);
    await runJob(billing, account.id, "j2", 1.83);
    await billing.payments.reportPendingUsage();
    await billing.deliverWebhooks();
    const [invoice] = await billing.store.listPaygInvoices(account.id);
    expect(invoice).toMatchObject({ status: "paid" });

    billing.provider.emit({
      type: "usage_invoice.failed",
      providerType: "invoice.payment_failed",
      invoice: { invoiceId: invoice!.providerInvoiceId, customer, credits: 599, amountCents: 599, reason: "threshold", hostedInvoiceUrl: null },
    });
    expect(await billing.deliverWebhooks()).toEqual([200]);
    expect((await billing.store.getAccount(account.id))?.aiPausedReason).toBeNull();
    expect((await billing.store.listPaygInvoices(account.id))[0]).toMatchObject({ status: "paid" });
  });

  // 2026-11-16 second review: an old sweep's paid event, sent again, reset
  // the threshold that a newer sweep had just lowered, before its invoice
  // existed, so the newer sweep collected nothing.
  it("an old sweep's paid event does not undo a newer sweep", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    await runJob(billing, account.id, "j1", 16.5);
    await runJob(billing, account.id, "j2", 0.4);
    await billing.payments.reportPendingUsage();
    billing.provider.drainWebhooks();
    await billing.payments.runMonthlySweep(account.id);
    // Deliver every event of this sweep (created, then paid), and keep them.
    const oldHooks: RawWebhook[] = [];
    for (let batch = billing.provider.drainWebhooks(); batch.length > 0; batch = billing.provider.drainWebhooks()) {
      for (const raw of batch) {
        oldHooks.push(raw);
        await billing.webhooks.handle(raw);
      }
    }
    expect(oldHooks.map((raw) => (JSON.parse(raw.body) as ProviderEvent).type)).toContain("usage_invoice.paid");
    expect(billing.provider.thresholdChanges.at(-1)?.amountCents).toBe(500);

    // A month later: new debt, and the next sweep lowers the threshold.
    billing.clock.advance(35 * 24 * 60 * 60 * 1_000);
    await runJob(billing, account.id, "j3", 16.5); // the new month's 5,000 credits
    await runJob(billing, account.id, "j4", 0.3); // 50 + 90 = 140 credits of debt
    await billing.payments.reportPendingUsage();
    billing.provider.drainWebhooks();
    const before = billing.provider.thresholdChanges.length;
    const swept = await billing.payments.runMonthlySweep(account.id);
    expect(swept.ran).toBe(true);
    const lowered = billing.provider.thresholdChanges.slice(before).map((change) => change.amountCents);
    expect(lowered.length).toBeGreaterThan(0);
    expect(lowered.at(-1)).toBeLessThan(500);

    // The old paid event arrives again before the new sweep's invoice. The
    // provider signs each delivery with the time it sends it.
    const changes = billing.provider.thresholdChanges.length;
    for (const raw of oldHooks) {
      const event = JSON.parse(raw.body) as ProviderEvent;
      // A new event ID: a separate, delayed event, which the dedupe does not stop.
      const resent = billing.provider.signEvent({ ...event, id: `${event.id}_late`, occurredAt: new Date(event.occurredAt) });
      expect((await billing.webhooks.handle(resent)).status).toBe(200);
    }
    expect(billing.provider.thresholdChanges.length).toBe(changes);
  });

  // 2026-11-16 second review: the failure and paid handlers changed the
  // invoice and the pause in separate locks, so they could interleave.
  it.each([
    ["failed, then paid", ["failed", "paid"]],
    ["paid, then failed", ["paid", "failed"]],
    ["at the same time", ["both"]],
  ] as const)("the pause follows the invoice: %s", async (_name, order) => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    const invoice = { invoiceId: "in_race", customer, credits: 599, amountCents: 599, reason: "threshold" as const, hostedInvoiceUrl: null };
    const occurredAt = billing.clock.now();
    const event = (kind: "failed" | "paid") =>
      kind === "failed"
        ? billing.provider.signEvent({ id: "evt_failed", type: "usage_invoice.failed", providerType: "invoice.payment_failed", occurredAt, invoice })
        : billing.provider.signEvent({ id: "evt_paid", type: "usage_invoice.paid", providerType: "invoice.paid", occurredAt, invoice });
    if (order[0] === "both") {
      const results = await Promise.all([billing.webhooks.handle(event("failed")), billing.webhooks.handle(event("paid"))]);
      expect(results.map((result) => result.status)).toEqual([200, 200]);
    } else {
      for (const kind of order) expect((await billing.webhooks.handle(event(kind))).status).toBe(200);
    }
    expect((await billing.store.listPaygInvoices(account.id))[0]).toMatchObject({ status: "paid" });
    expect((await billing.store.getAccount(account.id))?.aiPausedReason).toBeNull();
  });

  it("does not sweep below 50 credits", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    expect(await billing.payments.runMonthlySweep(account.id)).toEqual({ sweptCredits: 0, ran: true });
  });

  it("clears debt from a renewal invoice with usage lines", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    await runJob(billing, account.id, "j1", 16.5);
    await runJob(billing, account.id, "j2", 0.4);
    billing.provider.emit({
      type: "usage_invoice.paid",
      providerType: "invoice.paid",
      invoice: { invoiceId: "in_renewal", customer, credits: 170, amountCents: 20_900 + 170, reason: "renewal", hostedInvoiceUrl: null },
    });
    await billing.deliverWebhooks();
    expect(await openDebt(billing, account.id)).toBe(0);
    expect((await billing.store.listPaygInvoices(account.id))[0]).toMatchObject({ reason: "renewal", status: "paid" });
  });

  it("flags a dispute and turns pay-as-you-go off; a usage refund writes an adjustment", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    await runJob(billing, account.id, "j1", 16.5);
    await runJob(billing, account.id, "j2", 1.83);
    await billing.payments.reportPendingUsage();
    await billing.deliverWebhooks();
    const [invoice] = await billing.store.listPaygInvoices(account.id);
    billing.provider.refundInvoice(invoice!.providerInvoiceId);
    billing.provider.dispute(customer, invoice!.providerInvoiceId);
    await billing.deliverWebhooks();
    const stored = await billing.store.getAccount(account.id);
    expect(stored).toMatchObject({ aiPausedReason: "dispute" });
    expect(stored?.flaggedAt).not.toBeNull();
    const adjust = billing.store.allLedgerEntries(account.id).filter((entry) => entry.kind === "adjust");
    expect(adjust).toMatchObject([{ credits: 0, metadata: { refundedCredits: 599 } }]);
    expect(await openDebt(billing, account.id)).toBe(0);
  });
});
