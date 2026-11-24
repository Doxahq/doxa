import type {
  BillingAccountDetail,
  BillingAccountSummary,
  BillingInvoice,
  BillingLedgerEntry,
  BillingOffer,
  BillingPaymentMethod,
  BillingPlanIntervalPreview,
  BillingStartProNowPreview,
} from "@doxahq/contracts/billing"

/** Billing fixtures for the dashboard tests and the visual harness. Shapes follow `@doxahq/contracts/billing`. */

export const FOUNDER_OFFER: BillingOffer = {
  offerKey: "founder_v1",
  label: "Founder price",
  open: true,
  slotsLeft: 37,
  maxAccounts: 50,
  prices: {
    month: { priceKey: "pro_monthly_founder_v2", interval: "month", amountCents: 12_900, monthlyEquivalentCents: 12_900 },
    year: { priceKey: "pro_yearly_founder_v2", interval: "year", amountCents: 118_800, monthlyEquivalentCents: 9_900 },
  },
  yearlySavingsPercent: 19,
}

export const CLOSED_OFFER: BillingOffer = {
  ...FOUNDER_OFFER,
  open: false,
  slotsLeft: 0,
  prices: {
    month: { priceKey: "pro_monthly_v1", interval: "month", amountCents: 20_900, monthlyEquivalentCents: 20_900 },
    year: { priceKey: "pro_yearly_v1", interval: "year", amountCents: 202_800, monthlyEquivalentCents: 16_900 },
  },
}

const CAPS: BillingAccountDetail["caps"] = [
  { action: "generation.run", capCredits: 3_000, baseCredits: 50, minCap: 1_000, defaultCap: 3_000, maxCap: 10_000 },
  { action: "doxabot.run", capCredits: 500, baseCredits: 20, minCap: 500, defaultCap: 500, maxCap: 10_000 },
]

const PRO_FEATURES = {
  "ai.doxa_agent": true,
  "ai.doxabot": true,
  "ai.docs_chat": false,
  "ai.payg": true,
  "docs.publish_approvals": true,
  "site.remove_powered_by": true,
}

/** Free, no subscription: the page offers the upgrade. */
export const FREE_ACCOUNT: BillingAccountDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerKind: "user",
  ownerId: "user-1",
  name: null,
  plan: "free",
  planSource: "default",
  provider: "stripe",
  canManage: true,
  trialAvailable: true,
  subscription: null,
  entitlements: {
    hosting: "shared",
    features: { "ai.doxa_agent": false, "ai.doxabot": false, "ai.payg": false },
    limits: { "ai.credits_monthly": 0, "site.custom_domains": 1 },
  },
  credits: { available: 0, granted: 0, allowance: 0, allowanceResetsAt: "2026-12-14T00:00:00.000Z", held: 0 },
  payg: {
    enabled: true,
    active: false,
    offReason: "not_in_plan",
    debt: 0,
    debtInPayment: 0,
    monthTotal: 0,
    monthlyLimitCents: 3_000,
    monthlyLimitRangeCents: [500, 20_000],
    chargeAtCredits: 500,
    nextSweepAt: null,
    thresholdInvoiceOpen: false,
  },
  caps: CAPS,
  aiPausedReason: null,
  offers: [FOUNDER_OFFER],
  paymentMethod: null,
}

/** The card on file of the paid fixtures. */
export const VISA_CARD: BillingPaymentMethod = { brand: "visa", last4: "4242", expMonth: 8, expYear: 2029 }

/** Pro in the 7-day trial: trial credits, pay-as-you-go off. */
export const TRIAL_ACCOUNT: BillingAccountDetail = {
  ...FREE_ACCOUNT,
  trialAvailable: false,
  plan: "pro",
  planSource: "subscription",
  subscription: {
    status: "trialing",
    priceKey: "pro_yearly_founder_v2",
    currentPeriodStart: "2026-11-10T00:00:00.000Z",
    currentPeriodEnd: "2026-11-17T00:00:00.000Z",
    cancelAt: null,
    trialEnd: "2026-11-17T00:00:00.000Z",
    inGracePeriod: false,
  },
  entitlements: { hosting: "dedicated", features: PRO_FEATURES, limits: { "ai.credits_monthly": 5_000 } },
  credits: { available: 640, granted: 640, allowance: 5_000, allowanceResetsAt: "2026-12-10T00:00:00.000Z", held: 0 },
  payg: { ...FREE_ACCOUNT.payg, active: false, offReason: "trial" },
  offers: [],
  paymentMethod: VISA_CARD,
}

/** A trial canceled in Stripe: it ends on its date, and nothing follows it. */
export const CANCELED_TRIAL_ACCOUNT: BillingAccountDetail = {
  ...TRIAL_ACCOUNT,
  subscription: { ...TRIAL_ACCOUNT.subscription!, cancelAt: "2026-11-17T00:00:00.000Z" },
}

/** A trial canceled in Stripe that reached its end: the account is on Free again, and its trial is used. */
export const ENDED_TRIAL_ACCOUNT: BillingAccountDetail = {
  ...FREE_ACCOUNT,
  trialAvailable: false,
  subscription: { ...TRIAL_ACCOUNT.subscription!, status: "canceled", cancelAt: "2026-11-17T00:00:00.000Z" },
}

/** Paid Pro with a pay-as-you-go balance. */
export const ACTIVE_WITH_DEBT: BillingAccountDetail = {
  ...TRIAL_ACCOUNT,
  subscription: {
    ...TRIAL_ACCOUNT.subscription!,
    status: "active",
    currentPeriodStart: "2026-11-14T00:00:00.000Z",
    currentPeriodEnd: "2027-11-14T00:00:00.000Z",
    trialEnd: null,
  },
  credits: { available: 680, granted: 0, allowance: 5_000, allowanceResetsAt: "2026-12-14T00:00:00.000Z", held: 120 },
  payg: {
    ...FREE_ACCOUNT.payg,
    active: true,
    offReason: null,
    debt: 320,
    monthTotal: 1_420,
    debtInPayment: 0,
    // The sweep date comes from the billing anchor, not the allowance reset.
    nextSweepAt: "2026-12-20T00:00:00.000Z",
  },
}

/** A threshold invoice is open: "Charge in progress". */
export const CHARGE_IN_PROGRESS: BillingAccountDetail = {
  ...ACTIVE_WITH_DEBT,
  payg: { ...ACTIVE_WITH_DEBT.payg, debt: 540, debtInPayment: 500, thresholdInvoiceOpen: true },
}

/** The last payment failed. */
export const PAST_DUE_ACCOUNT: BillingAccountDetail = {
  ...ACTIVE_WITH_DEBT,
  subscription: { ...ACTIVE_WITH_DEBT.subscription!, status: "past_due", inGracePeriod: true },
  payg: { ...ACTIVE_WITH_DEBT.payg, active: false, offReason: "payment_failed", debtInPayment: 500 },
  aiPausedReason: "payment_failed",
}

export const INVOICES: BillingInvoice[] = [
  {
    invoiceId: "in_3",
    status: "open",
    reason: "threshold",
    amountDueCents: 500,
    amountPaidCents: 0,
    currency: "usd",
    usageCredits: 500,
    createdAt: "2026-11-12T10:00:00.000Z",
    hostedInvoiceUrl: "https://invoice.test/in_3",
    pdfUrl: "https://invoice.test/in_3.pdf",
  },
  {
    invoiceId: "in_2",
    status: "paid",
    reason: "threshold",
    amountDueCents: 500,
    amountPaidCents: 500,
    currency: "usd",
    usageCredits: 500,
    createdAt: "2026-11-05T10:00:00.000Z",
    hostedInvoiceUrl: "https://invoice.test/in_2",
    pdfUrl: "https://invoice.test/in_2.pdf",
  },
  {
    invoiceId: "in_1",
    status: "paid",
    reason: "subscription_create",
    amountDueCents: 118_800,
    amountPaidCents: 118_800,
    currency: "usd",
    usageCredits: 0,
    createdAt: "2026-10-14T10:00:00.000Z",
    hostedInvoiceUrl: "https://invoice.test/in_1",
    pdfUrl: "https://invoice.test/in_1.pdf",
  },
]

/** A settled generation (debit + debt + release), a Doxabot run and the monthly grant, newest first. */
export const LEDGER_ENTRIES: BillingLedgerEntry[] = [
  { id: "e6", kind: "release", credits: 0, actionKey: "generation.run", subjectKind: "job", subjectId: "job-aaaaaaaa-1", createdAt: "2026-11-13T12:00:00.000Z" },
  { id: "e5", kind: "debt", credits: -240, actionKey: "generation.run", subjectKind: "job", subjectId: "job-aaaaaaaa-1", createdAt: "2026-11-13T12:00:00.000Z" },
  { id: "e4", kind: "debit", credits: -60, actionKey: "generation.run", subjectKind: "job", subjectId: "job-aaaaaaaa-1", createdAt: "2026-11-13T12:00:00.000Z" },
  { id: "e3", kind: "debit", credits: -180, actionKey: "doxabot.run", subjectKind: "job", subjectId: "job-bbbbbbbb-2", createdAt: "2026-11-12T09:00:00.000Z" },
  { id: "e2", kind: "grant", credits: 5_000, actionKey: null, subjectKind: null, subjectId: null, createdAt: "2026-11-01T00:00:00.000Z" },
]

/** Seven invoices, newest first: more than the five the list shows at first. */
export const MANY_INVOICES: BillingInvoice[] = Array.from({ length: 7 }, (_, index) => ({
  invoiceId: `in_many_${index}`,
  status: "paid",
  reason: "threshold",
  amountDueCents: 500,
  amountPaidCents: 500,
  currency: "usd",
  usageCredits: 500,
  createdAt: new Date(Date.UTC(2026, 10, 20 - index, 10)).toISOString(),
  hostedInvoiceUrl: `https://invoice.test/in_many_${index}`,
  pdfUrl: `https://invoice.test/in_many_${index}.pdf`,
}))

export const PERSONAL_SUMMARY: BillingAccountSummary = {
  id: FREE_ACCOUNT.id,
  ownerKind: "user",
  ownerId: "user-1",
  name: null,
  plan: "pro",
  canManage: true,
}

export const TEAM_SUMMARY: BillingAccountSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  ownerKind: "team",
  ownerId: "team-1",
  name: "Acme team",
  plan: "free",
  canManage: true,
}

/** Yearly founder to monthly, 19 days into the year. */
export const YEAR_TO_MONTH_PREVIEW: BillingPlanIntervalPreview = {
  chargeTodayCents: 0,
  creditCents: 112_616,
  newPriceCents: 12_900,
  newInterval: "month",
  balanceAfterCents: 99_716,
}

export const START_PRO_NOW_PREVIEW: BillingStartProNowPreview = { amountCents: 118_800, currency: "usd", intervalLabel: "year" }
