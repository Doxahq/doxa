import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"
import type {
  BillingAccountDetail,
  BillingAccountList,
  BillingAccountSummary,
  BillingInterval,
  BillingInvoicePage,
  BillingLedgerPage,
  BillingOffer,
  BillingPlanIntervalPreview,
  BillingStartProNowPreview,
  CreditEstimate,
} from "@doxahq/contracts/billing"

import { ApiRequestError } from "~/lib/api-errors"
import {
  getBillingAccount,
  getCreditEstimate,
  getPlanIntervalPreview,
  getStartProNowPreview,
  listBillingAccounts,
  listBillingInvoices,
  listBillingLedgerEntries,
  listBillingOffers,
} from "~/lib/billing-api"

export type {
  BillingAccountDetail,
  BillingAccountList,
  BillingAccountSummary,
  BillingInvoicePage,
  BillingLedgerPage,
  BillingOffer,
  BillingPlanIntervalPreview,
  BillingStartProNowPreview,
  CreditEstimate,
}

const ROOT_KEY = ["billing"] as const

export const billingQueryKeys = {
  all: ROOT_KEY,
  accounts: () => [...ROOT_KEY, "accounts"] as const,
  /** Everything about one account. Invalidate it after a billing change. */
  account: (accountId: string) => [...ROOT_KEY, "account", accountId] as const,
  detail: (accountId: string) => [...billingQueryKeys.account(accountId), "detail"] as const,
  invoices: (accountId: string) => [...billingQueryKeys.account(accountId), "invoices"] as const,
  entries: (accountId: string) => [...billingQueryKeys.account(accountId), "entries"] as const,
  planIntervalPreview: (accountId: string, interval: BillingInterval) =>
    [...billingQueryKeys.account(accountId), "plan-interval-preview", interval] as const,
  startProNowPreview: (accountId: string) => [...billingQueryKeys.account(accountId), "start-pro-now-preview"] as const,
  offers: () => [...ROOT_KEY, "offers"] as const,
  estimate: (projectId: string, action: string) => [...ROOT_KEY, "estimate", projectId, action] as const,
}

/**
 * A billing error that a retry does not fix: billing is off on this server
 * (503 `billing_not_configured`), the account is not the viewer's (403/404),
 * or the route does not exist yet. Only an answer of the API itself counts:
 * an HTML 404 from a proxy or tunnel is not final.
 */
export function isFinalBillingError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.fromApi && [400, 401, 403, 404, 503].includes(error.status)
}

/** True when the API answered that the account is missing or not the viewer's. */
export function isBillingAccountNotFound(error: unknown): boolean {
  return error instanceof ApiRequestError && error.fromApi && (error.status === 403 || error.status === 404)
}

/** True when the API answered that billing is not configured on this server. */
export function isBillingNotConfigured(error: unknown): boolean {
  return error instanceof ApiRequestError && error.fromApi && (error.code === "billing_not_configured" || error.status === 503)
}

function retryBilling(failureCount: number, error: unknown): boolean {
  return !isFinalBillingError(error) && failureCount < 1
}

/** A preview answer of the API (400, 402, 409, 503) does not change on a retry: the dialog falls back at once. */
function retryPreview(failureCount: number, error: unknown): boolean {
  return !(error instanceof ApiRequestError && error.fromApi) && failureCount < 1
}

export function billingAccountsQueryOptions() {
  return queryOptions({
    queryKey: billingQueryKeys.accounts(),
    queryFn: listBillingAccounts,
    staleTime: 30_000,
    retry: retryBilling,
  })
}

export function billingAccountQueryOptions(accountId: string) {
  return queryOptions({
    queryKey: billingQueryKeys.detail(accountId),
    queryFn: () => getBillingAccount(accountId),
    staleTime: 10_000,
    retry: retryBilling,
  })
}

const INVOICES_PAGE_SIZE = 12
const ENTRIES_PAGE_SIZE = 50

export function billingInvoicesQueryOptions(accountId: string) {
  return infiniteQueryOptions({
    queryKey: billingQueryKeys.invoices(accountId),
    queryFn: ({ pageParam }) => listBillingInvoices(accountId, pageParam, INVOICES_PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (page: BillingInvoicePage) => page.nextCursor,
    staleTime: 30_000,
    retry: retryBilling,
  })
}

export function billingLedgerEntriesQueryOptions(accountId: string) {
  return infiniteQueryOptions({
    queryKey: billingQueryKeys.entries(accountId),
    queryFn: ({ pageParam }) => listBillingLedgerEntries(accountId, pageParam, ENTRIES_PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (page: BillingLedgerPage) => page.nextCursor,
    staleTime: 30_000,
    retry: retryBilling,
  })
}

/**
 * What the monthly/yearly switch to `interval` charges now. The confirm dialog
 * reads it while it is open; a new open reads it again.
 */
export function billingPlanIntervalPreviewQueryOptions(accountId: string, interval: BillingInterval) {
  return queryOptions({
    queryKey: billingQueryKeys.planIntervalPreview(accountId, interval),
    queryFn: () => getPlanIntervalPreview(accountId, interval),
    staleTime: 0,
    gcTime: 60_000,
    retry: retryPreview,
  })
}

/** What Start Pro now charges today, for its confirm dialog (decision D22). */
export function billingStartProNowPreviewQueryOptions(accountId: string) {
  return queryOptions({
    queryKey: billingQueryKeys.startProNowPreview(accountId),
    queryFn: () => getStartProNowPreview(accountId),
    staleTime: 0,
    gcTime: 60_000,
    retry: retryPreview,
  })
}

/** Public. The API caches it 60 seconds, so the page does too. */
export function billingOffersQueryOptions() {
  return queryOptions({
    queryKey: billingQueryKeys.offers(),
    queryFn: listBillingOffers,
    staleTime: 60_000,
    retry: retryBilling,
  })
}

export function creditEstimateQueryOptions(projectId: string, action: string) {
  return queryOptions({
    queryKey: billingQueryKeys.estimate(projectId, action),
    queryFn: () => getCreditEstimate(projectId, action),
    staleTime: 60_000,
    retry: retryBilling,
  })
}
