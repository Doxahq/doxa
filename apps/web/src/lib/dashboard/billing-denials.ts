import { useSyncExternalStore } from "react"
import type { CreditsExhaustedErrorDetails, PlanLimitErrorDetails } from "@doxahq/contracts/billing"

import {
  creditsExhaustedDetails,
  planLimitDetails,
  proTrialLimitReason,
  proTrialUnlocks,
  type StoppedRunSummary,
} from "~/lib/dashboard/billing-model"
import type { ProTrialRequest } from "~/lib/dashboard/pro-trial-dialog"

/**
 * The last billing denial of a mutation: a 402 `credits_exhausted` or a 403
 * `plan_limit` (billing spec 9.3, 10.6). The query client reports every failed
 * mutation here, so each start, invite or domain add opens the same dialog
 * without its own code. The dashboard layout draws the dialog. A 403 that the
 * Pro trial unlocks on a Free account opens the Pro trial dialog instead
 * (`usePlanLimitRouting`).
 */
export type BillingDenial =
  | {
      kind: "credits"
      details: CreditsExhaustedErrorDetails
      /** The stopped run, from a caller that knows it: the 402 details name no job. */
      run?: StoppedRunSummary
    }
  | { kind: "plan_limit"; details: PlanLimitErrorDetails }

let current: BillingDenial | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function showBillingDenial(denial: BillingDenial | null): void {
  current = denial
  emit()
}

/** Reports `error` when it is a billing denial. Returns true when it was one. */
export function reportBillingDenial(error: unknown): boolean {
  const credits = creditsExhaustedDetails(error)
  if (credits) {
    showBillingDenial({ kind: "credits", details: credits })
    return true
  }
  const limit = planLimitDetails(error)
  if (limit) {
    showBillingDenial({ kind: "plan_limit", details: limit })
    return true
  }
  return false
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBillingDenial(): BillingDenial | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}

/** The account and plan that a 403 `plan_limit` is about, as far as the dashboard knows them. */
export interface PlanLimitTarget {
  accountId: string | null
  plan: string | null
  canManage: boolean
}

/**
 * The account of a billing link of the API (`…/dashboard/billing/<id>`), else
 * null. The pricing page link names no account.
 */
export function accountIdFromBillingUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const match = /\/dashboard\/billing\/([^/?#]+)/.exec(new URL(url, "https://doxa.invalid").pathname)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

/**
 * The Pro trial dialog in place of "Plan limit reached" (billing spec 9.3):
 * only for a Free account, a key that Pro unlocks, and a known account. Every
 * other refusal keeps the plan limit dialog (null).
 */
export function planLimitProTrialRequest(details: PlanLimitErrorDetails, target: PlanLimitTarget): ProTrialRequest | null {
  const plan = details.plan ?? target.plan
  if (!target.accountId || !proTrialUnlocks(plan, details.key) || !plan) return null
  return { accountId: target.accountId, canManage: target.canManage, reason: proTrialLimitReason(details, plan) }
}
