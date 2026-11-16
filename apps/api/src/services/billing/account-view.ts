import {
  ACTION_KEYS,
  BillingInputError,
  allowanceWindow,
  ESTIMATE_HISTORY_RUNS,
  estimateRun,
  isActionKey,
  isUnlimited,
  meterPricingFor,
  resolveCap,
  type BillingAccount,
  type InvoiceSummary,
  type LedgerEntry,
  type LimitValue,
  type OfferView,
  type Page,
} from "@doxahq/billing";
import type {
  BillingAccountDetail,
  BillingInvoice,
  BillingLedgerEntry,
  BillingLimitValue,
  BillingOffer,
  CreditEstimate,
} from "@doxahq/contracts/billing";
import type { BillingRunHistory } from "../../repositories/billing-ownership";
import type { BillingCore } from "./core";
import type { BillingPaymentsRuntime } from "./payments-port";

const ENTITLED_STATUSES = new Set(["trialing", "active", "past_due"]);
const UNPAID_INVOICE_STATUSES = new Set(["draft", "open", "failed"]);
/** A threshold or sweep charge that the provider has not paid or failed yet (spec 10.10 steps 3 and 6). */
const CHARGE_IN_PROGRESS_STATUSES = new Set(["draft", "open"]);
const CHARGE_REASONS = new Set(["threshold", "sweep"]);
const SWEEP_STATUSES = new Set(["active", "past_due"]);

function limitValue(value: LimitValue): BillingLimitValue {
  return isUnlimited(value) ? "unlimited" : value;
}

export function toOfferDto(view: OfferView): BillingOffer {
  return {
    offerKey: view.offerKey,
    label: view.label,
    open: view.open,
    slotsLeft: view.slotsLeft,
    maxAccounts: view.maxAccounts,
    prices: { month: { ...view.prices.month }, year: { ...view.prices.year } },
    yearlySavingsPercent: view.yearlySavingsPercent,
  };
}

/** Every offer of the catalog, as a new Checkout would price it now (spec 7.5). */
export async function describeOffers(core: Pick<BillingCore, "catalog" | "offers">): Promise<BillingOffer[]> {
  return Promise.all(Object.keys(core.catalog.offers).map(async (key) => toOfferDto(await core.offers.describe(key))));
}

export interface AccountDetailOptions {
  /** The team name, or null for the personal account. */
  readonly name?: string | null;
  /** Reads the card on file (Node origin). Without it (a Worker build) `paymentMethod` is null. */
  readonly payments?: Pick<BillingPaymentsRuntime, "readPaymentMethod"> | null;
}

/** `GET /billing/accounts/:accountId` (billing spec 15.1). */
export async function readAccountDetail(
  core: BillingCore,
  account: BillingAccount,
  canManage: boolean,
  options: AccountDetailOptions = {},
): Promise<BillingAccountDetail> {
  // The one provider call of a detail read runs beside the store reads. It never throws.
  const paymentMethod = options.payments ? options.payments.readPaymentMethod(account.id) : Promise.resolve(null);
  const view = await core.entitlements.forAccount(account.id);
  const [balance, invoices] = await Promise.all([
    core.ledger.balance(account.id, view.creditContext),
    core.store.listPaygInvoices(account.id),
  ]);
  const current = view.account;
  const subscription = view.subscription;
  const entitled = subscription !== null && ENTITLED_STATUSES.has(subscription.status);
  const { entitlements } = view;
  const caps = ACTION_KEYS.flatMap((action) => {
    const pricing = meterPricingFor(core.catalog, action);
    if (!pricing || pricing.kind !== "metered") return [];
    return [
      {
        action,
        capCredits: resolveCap(pricing, current.actionCaps[action] ?? null),
        baseCredits: pricing.baseCredits,
        minCap: pricing.minCap,
        defaultCap: pricing.defaultCap,
        maxCap: pricing.maxCap,
      },
    ];
  });
  return {
    id: current.id,
    ownerKind: current.ownerKind,
    ownerId: current.ownerId,
    name: options.name ?? null,
    plan: entitlements.plan,
    planSource: entitlements.source,
    provider: current.provider ?? core.config.provider,
    canManage,
    // The mirror keeps an ended subscription, so null means the account never had one.
    trialAvailable: subscription === null,
    subscription: subscription
      ? {
          status: subscription.status,
          priceKey: subscription.priceKey,
          currentPeriodStart: subscription.currentPeriodStart.toISOString(),
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          cancelAt: subscription.cancelAtPeriodEnd ? subscription.currentPeriodEnd.toISOString() : null,
          trialEnd: subscription.trialEnd ? subscription.trialEnd.toISOString() : null,
          inGracePeriod: entitlements.inGracePeriod,
        }
      : null,
    entitlements: {
      hosting: entitlements.hosting,
      features: { ...entitlements.features },
      limits: Object.fromEntries(Object.entries(entitlements.limits).map(([key, value]) => [key, limitValue(value)])),
    },
    credits: {
      available: balance.available,
      granted: balance.granted,
      allowance: limitValue(entitlements.limits["ai.credits_monthly"]),
      allowanceResetsAt: balance.windowEnd.toISOString(),
      held: balance.held,
    },
    payg: {
      enabled: current.paygEnabled,
      active: balance.payg.active,
      offReason: balance.payg.offReason,
      debt: balance.openDebt,
      debtInPayment: invoices.filter((row) => UNPAID_INVOICE_STATUSES.has(row.status)).reduce((sum, row) => sum + row.credits, 0),
      monthTotal: balance.debtThisWindow,
      monthlyLimitCents: current.paygMonthlyLimitCents,
      monthlyLimitRangeCents: [...core.catalog.payg.monthlyLimitRangeCents],
      chargeAtCredits: core.catalog.payg.chargeAtCredits,
      nextSweepAt:
        subscription !== null && SWEEP_STATUSES.has(subscription.status)
          ? allowanceWindow(subscription.billingAnchor, core.clock.now()).end.toISOString()
          : null,
      thresholdInvoiceOpen: invoices.some((row) => CHARGE_REASONS.has(row.reason) && CHARGE_IN_PROGRESS_STATUSES.has(row.status)),
    },
    caps,
    aiPausedReason: current.aiPausedReason,
    offers: entitled ? [] : await describeOffers(core),
    paymentMethod: await paymentMethod,
  };
}

export function toLedgerEntryDto(entry: LedgerEntry): BillingLedgerEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    credits: entry.credits,
    actionKey: entry.actionKey,
    subjectKind: entry.subjectKind,
    subjectId: entry.subjectId,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toInvoicePage(page: Page<InvoiceSummary>): { invoices: BillingInvoice[]; nextCursor: string | null } {
  return {
    invoices: page.items.map((invoice) => ({ ...invoice, createdAt: invoice.createdAt.toISOString() })),
    nextCursor: page.nextCursor,
  };
}

/** Job IDs read for the estimate: enough to find 5 settled runs of one action among other runs. */
const ESTIMATE_JOB_SCAN = 20;

/**
 * `GET /projects/:projectId/credit-estimate?action=` (billing spec 10.5):
 * 1.5 × the median usage of the last 5 settled runs of the action, else the
 * action's default estimate, never above the account's cap.
 */
export async function estimateProjectRun(
  core: BillingCore,
  history: BillingRunHistory,
  input: { projectId: string; action: string },
): Promise<CreditEstimate> {
  const action = input.action;
  const pricing = isActionKey(action) ? meterPricingFor(core.catalog, action) : null;
  if (!isActionKey(action) || !pricing || pricing.kind !== "metered") {
    throw new BillingInputError("action_not_metered", "The action must be a metered action, such as generation.run or doxabot.run.");
  }
  const account = await core.accounts.resolveBillingAccount(input.projectId);
  const cap = resolveCap(pricing, account.actionCaps[action] ?? null);
  const jobIds = await history.recentJobIds(input.projectId, ESTIMATE_JOB_SCAN);
  const reservations = await Promise.all(jobIds.map((jobId) => core.store.findReservationBySubject("job", jobId)));
  const recentUsageCredits = reservations
    .filter((row) => row !== null && row.actionKey === action && row.status === "settled" && row.settledAmount !== null)
    .slice(0, ESTIMATE_HISTORY_RUNS)
    .map((row) => Math.max(0, (row?.settledAmount ?? 0) - (row?.baseCredits ?? 0)));
  const estimate = estimateRun({ pricing, capCredits: cap, recentUsageCredits });
  return { action, low: estimate.low, high: estimate.high, cap: estimate.cap, source: estimate.source };
}
