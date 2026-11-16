import { DAY_MS, type BillingProvider } from "@doxahq/billing";
import type { BillingPayments, BillingWebhooks } from "@doxahq/billing/payments";
import type { BillingCore } from "../../services/billing/core";
import type { GenerationMetering } from "../../services/billing/generation-metering";

export type BillingJobLog = (event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;

/** The daily jobs run at 12:00 UTC: outside the nightly ECS pause (00:00–09:00 UTC). */
export const BILLING_DAILY_HOUR_UTC = 12;
/** A usage report still unsent after this long counts as a reconcile difference. */
const STUCK_REPORT_MS = DAY_MS;
const PENDING_REPORT_SCAN = 10_000;
const EXPIRED_GRANT_BATCH = 500;

/** The cron ticks every 5 minutes: the first tick of an hour has minutes 0–4. */
export function isFirstTickOfHour(at: Date): boolean {
  return at.getUTCMinutes() < 5;
}

export function isFirstTickOfDay(at: Date): boolean {
  return at.getUTCHours() === BILLING_DAILY_HOUR_UTC && isFirstTickOfHour(at);
}

/**
 * The billing jobs (billing spec 14.3) in the 5-minute cron:
 *
 * - every tick: usage report retries (spec 10.10 step 2) and expired founder
 *   holds (spec 7.5; a hold whose payment is still coming is kept);
 * - once an hour: the event catch-up, a sync of accounts in `past_due`,
 *   `incomplete` or `trialing`, grant expiry, and the monthly sweep of each
 *   account whose current allowance window has not been swept yet (so a
 *   missed tick or a paused task catches up);
 * - once a day: the pay-as-you-go reconcile.
 *
 * - every tick: the credit sweep, which settles the holds of ended jobs and
 *   releases holds older than 24 hours whose job is gone (spec 10.5), when
 *   the meter is on.
 *
 * Each job runs on its own: a failure is logged and the others still run.
 */
export class BillingJobs {
  constructor(
    private readonly deps: {
      readonly core: BillingCore;
      readonly payments: BillingPayments;
      readonly webhooks: BillingWebhooks;
      readonly provider: BillingProvider;
      readonly log: BillingJobLog;
      readonly metering?: Pick<GenerationMetering, "sweep">;
    },
  ) {}

  async run(scheduledTime: number): Promise<void> {
    const at = new Date(scheduledTime);
    const jobs: [string, () => Promise<Readonly<Record<string, string | number | boolean | null>>>][] = [
      ["payg.report", () => this.deps.payments.reportPendingUsage()],
      ["offers.expired_holds", () => this.deps.payments.releaseExpiredHolds()],
    ];
    const { metering } = this.deps;
    if (metering) jobs.push(["credits.sweep", () => metering.sweep()]);
    if (isFirstTickOfHour(at)) {
      jobs.push(
        ["billing.catch_up", () => this.deps.webhooks.catchUp()],
        ["billing.sync_open", async () => ({ synced: await this.deps.payments.syncOpenSubscriptions() })],
        ["credits.expire", () => this.expireGrants()],
        ["payg.sweep", () => this.monthlySweep()],
      );
    }
    if (isFirstTickOfDay(at)) jobs.push(["payg.reconcile", () => this.reconcile()]);
    for (const [name, job] of jobs) await this.step(name, job);
  }

  /** Expired grants get an `expire` ledger entry for the audit record. */
  private async expireGrants(): Promise<{ accounts: number; expired: number }> {
    const { store, ledger, clock } = this.deps.core;
    const ids = await store.listAccountIdsWithExpiredGrants(clock.now(), EXPIRED_GRANT_BATCH);
    let expired = 0;
    for (const id of ids) expired += (await ledger.expireGrants(id)).expired;
    return { accounts: ids.length, expired };
  }

  /**
   * Billing spec 14.3, the daily pay-as-you-go check. The provider port has
   * no read of the usage the provider has not charged yet, so this compares
   * the local side: the open debt against unpaid invoices and usage reports
   * that never reached the provider, after a fresh `syncCustomer`.
   */
  private async reconcile(): Promise<{ accounts: number; differences: number }> {
    const { store, entitlements, ledger, clock } = this.deps.core;
    const ids = await store.listAccountIdsBySubscriptionStatus(["active", "past_due"]);
    const pending = await store.listPendingUsageReports(PENDING_REPORT_SCAN);
    const now = clock.now().getTime();
    let differences = 0;
    for (const id of ids) {
      const view = await entitlements.forAccount(id);
      const balance = await ledger.balance(id, view.creditContext);
      if (balance.openDebt === 0) continue;
      const invoices = await store.listPaygInvoices(id);
      const invoicedUnpaid = invoices
        .filter((row) => row.status === "draft" || row.status === "open" || row.status === "failed")
        .reduce((sum, row) => sum + row.credits, 0);
      const stuck = pending.filter((row) => row.accountId === id && now - row.createdAt.getTime() >= STUCK_REPORT_MS);
      if (stuck.length === 0) continue;
      differences += 1;
      this.deps.log("payg.reconcile_diff", {
        accountId: id,
        openDebt: balance.openDebt,
        invoicedUnpaid,
        stuckReports: stuck.length,
        stuckCredits: stuck.reduce((sum, row) => sum + row.credits, 0),
      });
    }
    return { accounts: ids.length, differences };
  }

  /**
   * Billing spec 10.10 step 6: once in each allowance window of each account.
   * `runMonthlySweep` compares the window with the account's last swept
   * window (`payg_swept_window_start`), so it is idempotent for each account
   * and window, and a window that a missed tick skipped is swept late.
   */
  private async monthlySweep(): Promise<{ accounts: number; ran: number; swept: number; failed: number }> {
    const { store } = this.deps.core;
    const ids = await store.listAccountIdsBySubscriptionStatus(["active", "past_due"]);
    let ran = 0;
    let swept = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const result = await this.deps.payments.runMonthlySweep(id);
        if (result.ran) ran += 1;
        if (result.sweptCredits > 0) swept += 1;
      } catch (cause) {
        // One account's provider error must not stop the others; the next hour retries it.
        failed += 1;
        this.deps.log("payg.sweep_failed", { accountId: id, error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error" });
      }
    }
    return { accounts: ids.length, ran, swept, failed };
  }

  private async step(name: string, job: () => Promise<Readonly<Record<string, string | number | boolean | null>>>): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await job();
      this.deps.log("billing.sync", { job: name, outcome: "ok", durationMs: Date.now() - startedAt, ...result });
    } catch (cause) {
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
      this.deps.log("billing.sync", { job: name, outcome: "failed", durationMs: Date.now() - startedAt, error: message });
    }
  }
}
