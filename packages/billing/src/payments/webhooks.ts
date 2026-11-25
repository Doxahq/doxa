import type { Catalog } from "../catalog/define";
import { MINUTE_MS, addMs, type Clock } from "../clock";
import { allowanceWindow } from "../credits/allowance";
import { chargeThresholdCents } from "../credits/payg";
import type { CreditLedger } from "../credits/ledger";
import { BillingUnknownCustomerError } from "../errors";
import type { OfferSlots } from "../offers/founder";
import { ProviderSignatureError, ProviderUnavailableError } from "../provider/errors";
import type { BillingProvider, PlanInvoiceRef, ProviderCustomerRef, ProviderEvent, RawWebhook, UsageInvoiceRef } from "../provider/provider";
import type { AccountTx, BillingStore } from "../store/store";
import type { BillingAccount, PaygInvoice, PaygInvoiceReason, PaygInvoiceStatus } from "../store/types";
import { NO_BILLING_LIFECYCLE_EVENTS, notifyLifecycle, priceFacts, type BillingLifecycleEvents } from "../lifecycle-events";
import type { BillingPayments, SyncResult } from "./service";

/** The raw body limit of the webhook route (spec 14.1 step 1). */
export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
/** A `received` event older than this is taken over by the next delivery (a crash mid-processing). */
const STALE_EVENT_MS = 5 * MINUTE_MS;

export interface WebhookResponse {
  readonly status: 200 | 400 | 413 | 500;
  readonly body: { readonly ok: boolean; readonly duplicate?: boolean; readonly error?: string };
}

export interface BillingWebhooksDeps {
  readonly store: BillingStore;
  readonly catalog: Catalog;
  readonly clock: Clock;
  readonly provider: BillingProvider;
  readonly payments: BillingPayments;
  readonly ledger: CreditLedger;
  readonly offers: OfferSlots;
  readonly log?: (event: { name: string; fields: Readonly<Record<string, string | number | boolean | null>> }) => void;
  /** Product analytics facts: Checkout and invoice outcomes. Default: none. */
  readonly lifecycle?: BillingLifecycleEvents;
}

/**
 * The provider-neutral webhook flow (spec 14.1): verify, store, dispatch.
 *
 * 1. `parseWebhook` checks the signature. A bad one answers 400 and stores nothing.
 * 2. `(provider, event_id)` goes into `billing_provider_events`. A duplicate answers 200.
 * 3. The event is processed in the same request.
 * 4. The event is marked `processed`, or `failed` with the error and a 500, so the provider retries.
 *
 * The event body is never trusted for plan state: `customer.changed` reads
 * the provider again through `syncCustomer`.
 */
export class BillingWebhooks {
  constructor(private readonly deps: BillingWebhooksDeps) {}

  private get lifecycle(): BillingLifecycleEvents {
    return this.deps.lifecycle ?? NO_BILLING_LIFECYCLE_EVENTS;
  }

  async handle(raw: RawWebhook): Promise<WebhookResponse> {
    if (new TextEncoder().encode(raw.body).byteLength > WEBHOOK_BODY_LIMIT_BYTES) {
      return { status: 413, body: { ok: false, error: "body_too_large" } };
    }
    let event: ProviderEvent;
    try {
      event = await this.deps.provider.parseWebhook(raw);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) return { status: 500, body: { ok: false, error: "provider_unavailable" } };
      const reason = error instanceof ProviderSignatureError ? "bad_signature" : "bad_event";
      this.log("billing.webhook", { outcome: reason });
      return { status: 400, body: { ok: false, error: reason } };
    }
    return this.process(event);
  }

  /** Claims, dispatches and completes one event. Also used by the sync job for events the webhook missed. */
  async process(event: ProviderEvent): Promise<WebhookResponse> {
    const now = this.deps.clock.now();
    const claim = await this.deps.store.claimProviderEvent({
      provider: this.deps.provider.name,
      eventId: event.id,
      type: event.type,
      now,
      staleBefore: addMs(now, -STALE_EVENT_MS),
    });
    if (claim === "duplicate") {
      this.log("billing.webhook", { type: event.type, outcome: "duplicate" });
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    try {
      await this.dispatch(event);
      await this.deps.store.completeProviderEvent({ provider: this.deps.provider.name, eventId: event.id, status: "processed", error: null, now: this.deps.clock.now() });
      this.log("billing.webhook", { type: event.type, outcome: "processed" });
      return { status: 200, body: { ok: true } };
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
      await this.deps.store.completeProviderEvent({ provider: this.deps.provider.name, eventId: event.id, status: "failed", error: message, now: this.deps.clock.now() });
      this.log("billing.webhook", { type: event.type, outcome: "failed" });
      return { status: 500, body: { ok: false, error: "processing_failed" } };
    }
  }

  /** The hourly catch-up (spec 14.3): every event after the stored cursor. */
  async catchUp(): Promise<{ processed: number; failed: number }> {
    const cursor = await this.deps.store.getSyncCursor(this.deps.provider.name);
    const page = await this.deps.provider.listEventsSince(cursor);
    let processed = 0;
    let failed = 0;
    for (const event of page.items) {
      const result = await this.process(event);
      if (result.status === 200) processed += 1;
      else failed += 1;
    }
    // A failed event keeps its row as `failed`; the provider's own retry, or a manual replay, takes it again.
    await this.deps.store.setSyncCursor(this.deps.provider.name, page.nextCursor ?? cursor, this.deps.clock.now());
    return { processed, failed };
  }

  private async dispatch(event: ProviderEvent): Promise<void> {
    switch (event.type) {
      case "customer.changed": {
        const synced = await this.syncKnownCustomer(event.customer);
        if (synced && event.invoice) this.planInvoiceSettled(synced.accountId, event.invoice);
        return;
      }
      case "checkout.completed": {
        const synced = event.customer
          ? await this.deps.payments.syncCustomer(event.customer, event.accountId)
          : await this.deps.payments.syncCheckout(event.checkoutId);
        if (synced) await this.checkoutCompleted(synced);
        return;
      }
      case "checkout.expired": {
        await this.deps.offers.releaseByCheckout(event.checkoutId);
        const accountId = event.accountId;
        if (accountId) notifyLifecycle(() => this.lifecycle.checkoutExpired?.({ accountId }));
        return;
      }
      case "usage_invoice.created":
        await this.onUsageInvoiceCreated(event.invoice);
        return;
      case "usage_invoice.paid":
        await this.onUsageInvoicePaid(event.invoice);
        return;
      case "usage_invoice.failed":
        await this.onUsageInvoiceFailed(event.invoice);
        return;
      case "payment.refunded": {
        if (event.usageCredits <= 0) return; // a subscription refund changes no credits (spec 10.4)
        const account = await this.accountOf(event.customer.customerId);
        await this.deps.ledger.recordAdjustment({
          accountId: account.id,
          idempotencyKey: `refund:${event.invoiceId ?? event.id}`,
          metadata: { reason: "usage_refund", invoiceId: event.invoiceId, refundedCredits: event.usageCredits, amountCents: event.amountCents },
        });
        return;
      }
      case "payment.disputed": {
        const account = await this.accountOf(event.customer.customerId);
        // Pay-as-you-go off and a review flag; the debt stays open (spec 10.4).
        await this.deps.store.withAccountLock(account.id, this.deps.clock.now(), (tx) =>
          tx.updateAccount({ aiPausedReason: "dispute", flaggedAt: tx.account.flaggedAt ?? tx.now }),
        );
        return;
      }
      case "ignored":
        return;
    }
  }

  /**
   * Syncs a customer, and skips one that Doxa did not make. Such an event would
   * fail on every retry, so it is processed as ignored. A Doxa customer whose
   * account is gone still fails: that is a fault in Doxa's own data.
   */
  private async syncKnownCustomer(customer: ProviderCustomerRef): Promise<SyncResult | null> {
    try {
      return await this.deps.payments.syncCustomer(customer);
    } catch (error) {
      if (!(error instanceof BillingUnknownCustomerError)) throw error;
      this.log("billing.webhook", { type: "customer.changed", outcome: "unknown_customer", customerId: customer.customerId });
      return null;
    }
  }

  /** The price comes from the mirror that the sync just wrote, read only when a listener wants it. */
  private async checkoutCompleted(synced: SyncResult): Promise<void> {
    const listener = this.lifecycle.checkoutCompleted?.bind(this.lifecycle);
    if (!listener) return;
    const subscription = await this.deps.store.getSubscription(synced.accountId);
    const priceKey = subscription?.priceKey ?? null;
    const interval = priceKey ? (priceFacts(this.deps.catalog, priceKey)?.interval ?? null) : null;
    notifyLifecycle(() => listener({ accountId: synced.accountId, priceKey, interval }));
  }

  /** A trial's $0 invoice is not a payment, so it is not reported. */
  private planInvoiceSettled(accountId: string, invoice: PlanInvoiceRef): void {
    if (invoice.amountCents <= 0) return;
    notifyLifecycle(() =>
      this.lifecycle.invoiceSettled?.({ accountId, outcome: invoice.outcome, kind: "plan", amountCents: invoice.amountCents, attempt: invoice.attempt }),
    );
  }

  /** Once for each invoice and outcome: a replayed or late event finds the stored status. */
  private usageInvoiceSettled(accountId: string, invoice: UsageInvoiceRef, outcome: "paid" | "failed", previous: PaygInvoiceStatus | null): void {
    if (previous === "paid" || previous === outcome) return;
    notifyLifecycle(() =>
      this.lifecycle.invoiceSettled?.({ accountId, outcome, kind: "usage", amountCents: invoice.amountCents, attempt: null }),
    );
  }

  private async onUsageInvoiceCreated(invoice: UsageInvoiceRef): Promise<void> {
    const account = await this.accountOf(invoice.customer.customerId);
    const { row: stored } = await this.upsertInvoice(account, invoice, "draft");
    if (stored.status === "paid") return;
    const collect = this.deps.provider.collectThresholdInvoice?.bind(this.deps.provider);
    if (invoice.reason !== "threshold" || !collect) return;
    // Finalize and pay at once, so the charge does not wait an hour for the draft (spec 10.10 step 3).
    const result = await collect(invoice.invoiceId);
    if (result.status === "paid") await this.onUsageInvoicePaid({ ...invoice, credits: result.usageCredits || invoice.credits });
  }

  private async onUsageInvoicePaid(invoice: UsageInvoiceRef): Promise<void> {
    const account = await this.accountOf(invoice.customer.customerId);
    await this.deps.ledger.recordDebtPaid({ accountId: account.id, invoiceId: invoice.invoiceId, credits: invoice.credits });
    const { row: stored, previous } = await this.upsertInvoice(account, invoice, "paid");
    this.usageInvoiceSettled(account.id, invoice, "paid", previous);
    // A sweep lowered the threshold; set it back to the charge amount (spec
    // 10.10 step 6). On a replay too: if the reset failed, the provider sends
    // the event again, and the debt is already paid by then. The reset sets
    // a fixed amount, so a second one changes nothing.
    if (stored.reason === "sweep" && (await this.isCurrentSweep(account.id, stored))) {
      await this.resetThreshold(account);
    }
  }

  private async onUsageInvoiceFailed(invoice: UsageInvoiceRef): Promise<void> {
    const account = await this.accountOf(invoice.customer.customerId);
    // The pause follows from the stored invoices (`upsertInvoice`): a late
    // failure of an invoice that is paid changes nothing.
    const { previous } = await this.upsertInvoice(account, invoice, "failed");
    this.usageInvoiceSettled(account.id, invoice, "failed", previous);
  }

  /**
   * True when a paid sweep invoice may set the threshold back: it is from
   * the current allowance window, and no other sweep invoice is draft or
   * open. A sweep runs once in each window and lowers the threshold before
   * its invoice exists, so an event of an older window must not undo it.
   */
  private async isCurrentSweep(accountId: string, stored: PaygInvoice): Promise<boolean> {
    const subscription = await this.deps.store.getSubscription(accountId);
    if (!subscription) return false;
    const window = allowanceWindow(subscription.billingAnchor, this.deps.clock.now());
    if (stored.createdAt.getTime() < window.start.getTime()) return false;
    const invoices = await this.deps.store.listPaygInvoices(accountId);
    return !invoices.some(
      (row) => row.providerInvoiceId !== stored.providerInvoiceId && row.reason === "sweep" && (row.status === "draft" || row.status === "open"),
    );
  }

  /**
   * The AI pause for a failed payment, from the account's invoices, under the
   * same lock as the invoice status. Events can arrive in any order and at
   * the same time: a failure pauses only while its invoice is not paid, and
   * a payment clears the pause only when no failed invoice is left.
   */
  private async applyPaymentPause(tx: AccountTx, status: PaygInvoiceStatus): Promise<void> {
    if (status !== "failed" && status !== "paid") return;
    const anyFailed = (await tx.listPaygInvoices()).some((row) => row.status === "failed");
    if (anyFailed && tx.account.aiPausedReason === null) await tx.updateAccount({ aiPausedReason: "payment_failed" });
    if (!anyFailed && tx.account.aiPausedReason === "payment_failed") await tx.updateAccount({ aiPausedReason: null });
  }

  /** The stored invoice, and its status before this event (null for a new one). */
  private async upsertInvoice(
    account: BillingAccount,
    invoice: UsageInvoiceRef,
    status: PaygInvoiceStatus,
  ): Promise<{ row: PaygInvoice; previous: PaygInvoiceStatus | null }> {
    const now = this.deps.clock.now();
    return this.deps.store.withAccountLock(account.id, now, async (tx) => {
      const existing = await tx.getPaygInvoice(invoice.invoiceId);
      // A paid invoice stays paid, whatever order the events arrive in.
      const nextStatus: PaygInvoiceStatus = existing?.status === "paid" ? "paid" : status;
      const row: PaygInvoice = {
        accountId: account.id,
        providerInvoiceId: invoice.invoiceId,
        credits: invoice.credits,
        amountCents: invoice.amountCents,
        status: nextStatus,
        reason: existing?.reason ?? this.reasonOf(invoice),
        createdAt: existing?.createdAt ?? now,
        paidAt: nextStatus === "paid" ? (existing?.paidAt ?? now) : null,
      };
      await tx.upsertPaygInvoice(row);
      await this.applyPaymentPause(tx, status);
      return { row, previous: existing?.status ?? null };
    });
  }

  /**
   * spec: the provider marks a sweep invoice as a threshold invoice. An
   * invoice below the normal charge amount can only come from a lowered
   * threshold, so it counts as a sweep.
   */
  private reasonOf(invoice: UsageInvoiceRef): PaygInvoiceReason {
    if (invoice.reason === "renewal" || invoice.reason === "final") return "renewal";
    return invoice.amountCents < chargeThresholdCents(this.deps.catalog) ? "sweep" : "threshold";
  }

  private async resetThreshold(account: BillingAccount): Promise<void> {
    const set = this.deps.provider.setChargeThreshold?.bind(this.deps.provider);
    const subscription = await this.deps.store.getSubscription(account.id);
    if (!set || !subscription || !account.providerCustomerId) return;
    await set({
      customer: { provider: this.deps.provider.name, customerId: account.providerCustomerId },
      subscriptionId: subscription.providerSubscriptionId,
      amountCents: chargeThresholdCents(this.deps.catalog),
    });
  }

  private async accountOf(customerId: string): Promise<BillingAccount> {
    const account = await this.deps.store.findAccountByProviderCustomer(this.deps.provider.name, customerId);
    if (!account) throw new Error(`No billing account for customer ${customerId}.`);
    return account;
  }

  private log(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void {
    this.deps.log?.({ name, fields });
  }
}
