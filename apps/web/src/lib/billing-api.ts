import {
  billingAccountDetailSchema,
  billingAccountListSchema,
  billingInvoicePageSchema,
  billingLedgerPageSchema,
  billingOffersSchema,
  billingPlanIntervalPreviewSchema,
  billingPlanIntervalResultSchema,
  billingRedirectSchema,
  billingStartProNowPreviewSchema,
  creditEstimateSchema,
  type BillingAccountDetail,
  type BillingAccountList,
  type BillingInvoicePage,
  type BillingLedgerPage,
  type BillingInterval,
  type BillingOffer,
  type BillingPaygInput,
  type BillingPlanIntervalPreview,
  type BillingPortalInput,
  type BillingStartProNowPreview,
  type CreditEstimate,
} from "@doxahq/contracts/billing"
import { z } from "zod"

import { apiFetch } from "~/lib/platform-api"

/**
 * The billing routes of the API (billing spec 15.1). The client never names a
 * plan, an amount or a provider price ID: it sends catalog price keys that the
 * person saw, and the API checks them.
 */

function accountPath(accountId: string): string {
  return `/billing/accounts/${encodeURIComponent(accountId)}`
}

function pageQuery(cursor: string | null, limit: number): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set("cursor", cursor)
  return params.toString()
}

/**
 * The personal account and each team account the viewer can read, and the
 * server's `BILLING_ENFORCEMENT` (the dashboard gates only when it is `on`).
 */
export async function listBillingAccounts(): Promise<BillingAccountList> {
  return billingAccountListSchema.parse(await apiFetch<unknown>("/billing/accounts"))
}

export async function getBillingAccount(accountId: string): Promise<BillingAccountDetail> {
  return billingAccountDetailSchema.parse(await apiFetch<unknown>(accountPath(accountId)))
}

export async function listBillingLedgerEntries(accountId: string, cursor: string | null, limit = 50): Promise<BillingLedgerPage> {
  const payload = await apiFetch<unknown>(`${accountPath(accountId)}/credits/entries?${pageQuery(cursor, limit)}`)
  return billingLedgerPageSchema.parse(payload)
}

export async function listBillingInvoices(accountId: string, cursor: string | null, limit = 25): Promise<BillingInvoicePage> {
  const payload = await apiFetch<unknown>(`${accountPath(accountId)}/invoices?${pageQuery(cursor, limit)}`)
  return billingInvoicePageSchema.parse(payload)
}

/** Public, cached 60 seconds by the API. */
export async function listBillingOffers(): Promise<BillingOffer[]> {
  return billingOffersSchema.parse(await apiFetch<unknown>("/billing/offers")).offers
}

/**
 * `offer` is the catalog price key the person saw. Answers 409 `offer_closed`
 * when the founder offer filled up. `returnPath` (a `/dashboard/...` path) is
 * where Checkout returns, in place of the account's billing page.
 */
export async function createBillingCheckout(accountId: string, offer: string, returnPath?: string): Promise<string> {
  const json = returnPath === undefined ? { offer } : { offer, returnPath }
  const payload = await apiFetch<unknown>(`${accountPath(accountId)}/checkout`, { method: "POST", json })
  return billingRedirectSchema.parse(payload).url
}

export async function createBillingPortal(accountId: string, flow?: BillingPortalInput["flow"]): Promise<string> {
  const payload = await apiFetch<unknown>(`${accountPath(accountId)}/portal`, {
    method: "POST",
    json: flow ? { flow } : {},
  })
  return billingRedirectSchema.parse(payload).url
}

/** The Checkout return (spec 14.2): the account as the provider has it now. */
export async function syncBillingCheckout(sessionId: string): Promise<BillingAccountDetail> {
  const payload = await apiFetch<unknown>(`/billing/checkout/${encodeURIComponent(sessionId)}/sync`, { method: "POST" })
  return billingAccountDetailSchema.parse(payload)
}

const paygSettingsSchema = z.object({ enabled: z.boolean(), monthlyLimitCents: z.number().int() })
export type BillingPaygSettings = z.infer<typeof paygSettingsSchema>

export async function updateBillingPayg(accountId: string, input: BillingPaygInput): Promise<BillingPaygSettings> {
  const payload = await apiFetch<unknown>(`${accountPath(accountId)}/payg`, { method: "PUT", json: input })
  return paygSettingsSchema.parse(payload)
}

export async function updateBillingCap(accountId: string, action: string, capCredits: number): Promise<void> {
  await apiFetch<unknown>(`${accountPath(accountId)}/caps`, { method: "PUT", json: { action, capCredits } })
}

/**
 * The monthly/yearly switch (spec 13). The `Idempotency-Key` makes a retry of
 * the same switch safe: the caller keeps one key for one attempt.
 */
export async function switchBillingPlanInterval(
  accountId: string,
  interval: "month" | "year",
  idempotencyKey: string,
): Promise<string> {
  const payload = await apiFetch<unknown>(`${accountPath(accountId)}/plan-interval`, {
    method: "POST",
    json: { interval },
    headers: { "Idempotency-Key": idempotencyKey },
  })
  return billingPlanIntervalResultSchema.parse(payload).priceKey
}

/** What the monthly/yearly switch charges now, from the provider's invoice preview. It changes nothing. */
export async function getPlanIntervalPreview(accountId: string, interval: BillingInterval): Promise<BillingPlanIntervalPreview> {
  const query = new URLSearchParams({ interval }).toString()
  return billingPlanIntervalPreviewSchema.parse(await apiFetch<unknown>(`${accountPath(accountId)}/plan-interval/preview?${query}`))
}

/** What Start Pro now (decision D22) charges today. It changes nothing. */
export async function getStartProNowPreview(accountId: string): Promise<BillingStartProNowPreview> {
  return billingStartProNowPreviewSchema.parse(await apiFetch<unknown>(`${accountPath(accountId)}/start-pro-now`))
}

/**
 * Start Pro now (decision D22): ends the trial, charges the plan and answers
 * the synced account. A declined card answers 402 `payment_failed` and
 * changes nothing; an account that is not in its trial answers 409.
 */
export async function startProNow(accountId: string): Promise<BillingAccountDetail> {
  return billingAccountDetailSchema.parse(await apiFetch<unknown>(`${accountPath(accountId)}/start-pro-now`, { method: "POST" }))
}

export async function getCreditEstimate(projectId: string, action: string): Promise<CreditEstimate> {
  const query = new URLSearchParams({ action }).toString()
  return creditEstimateSchema.parse(await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/credit-estimate?${query}`))
}
