import type { CheckoutLink, CheckoutResult, InvoiceSummary, Page, PaymentMethodSummary, PlanKey, PortalLink, RawWebhook } from "@doxahq/billing";
import type { BillingPlanIntervalPreview, BillingStartProNowPreview } from "@doxahq/contracts/billing";
import type { Env } from "../../env";

/**
 * What the shared API code needs from `@doxahq/billing/payments`. Billing
 * spec 6.2: only `apps/api/src/runtime/node/**` imports that entry, because
 * `doxa-mcp` and `doxa-docs-resolver` build from `apps/api` as Workers. The
 * Node origin builds the real one (`runtime/node/billing.ts`) and passes it
 * as the `BILLING_PAYMENTS` binding, as it passes `IMAGE_COMPRESSOR`.
 */
export interface BillingPaymentsRuntime {
  /** The provider name (`stripe`, `memory`, `none`). */
  readonly providerName: string;
  createCheckout(input: {
    accountId: string;
    priceKey: string;
    requestId: string;
    email?: string | null;
    name?: string | null;
    /** A dashboard path to return to in place of the billing page; refused with `BillingInputError` (400) otherwise. */
    returnPath?: string | null;
  }): Promise<CheckoutLink>;
  createPortalSession(input: {
    accountId: string;
    flow?: "payment_method_update" | "subscription_cancel" | null;
  }): Promise<PortalLink>;
  /**
   * The monthly/yearly switch (the Customer Portal cannot update a
   * subscription with a usage price). A founder stays on the founder price.
   * The subscription mirror is synced before this resolves.
   */
  switchPlanInterval(input: { accountId: string; interval: "month" | "year"; requestId: string }): Promise<{ priceKey: string }>;
  /**
   * What `switchPlanInterval` charges now (the provider's invoice preview).
   * 409 `same_interval` for the current interval, `no_subscription` without one.
   */
  previewPlanInterval(input: { accountId: string; interval: "month" | "year" }): Promise<BillingPlanIntervalPreview>;
  /**
   * Start Pro now (decision D22): ends the trial, charges the plan and syncs
   * the account. 409 `not_trialing`; a declined card is `ProviderRejectedError`
   * with `PAYMENT_FAILED` (402 `payment_failed`) and changes nothing.
   */
  startProNow(input: { accountId: string; requestId: string }): Promise<void>;
  /** What Start Pro now charges today. 409 `not_trialing`. */
  previewStartProNow(input: { accountId: string }): Promise<BillingStartProNowPreview>;
  /** The card on file, or null. Never throws: a provider failure is null and a log line. */
  readPaymentMethod(accountId: string): Promise<PaymentMethodSummary | null>;
  listInvoices(input: { accountId: string; limit: number; cursor?: string | null }): Promise<Page<InvoiceSummary>>;
  /** The Checkout Session as the provider has it: the route checks its account before a sync. */
  fetchCheckout(checkoutId: string): Promise<CheckoutResult>;
  syncCheckout(checkoutId: string): Promise<{ accountId: string; from: PlanKey; to: PlanKey; changed: boolean } | null>;
  /** Billing spec 14.1: verify, store, process. Answers 200, 400, 413 or 500. */
  handleWebhook(raw: RawWebhook): Promise<{ status: 200 | 400 | 413 | 500; body: Readonly<Record<string, unknown>> }>;
  /** Billing spec 14.3: the billing jobs of one 5-minute cron tick. */
  runScheduledJobs(scheduledTime: number): Promise<void>;
}

export interface BillingPaymentsBinding {
  /** The runtime of one request or cron tick: it uses that env's database scope. */
  forEnv(env: Env): BillingPaymentsRuntime;
}
