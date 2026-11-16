import { DOXA_CATALOG } from "@doxahq/billing/catalog"
import type { ProjectGenerationCache } from "@doxahq/contracts"
import type { BillingAccountDetail, CreditEstimate } from "@doxahq/contracts/billing"

import {
  actionLabel,
  creditMeterView,
  estimatePaygSentence,
  estimateSentence,
  formatCredits,
} from "~/lib/dashboard/billing-model"

/**
 * The run-type parts of a credit estimate (billing spec 10.5, decision D21):
 * the Full generation or Update run label, the cold sentence, the trial cap
 * note, and the estimate of a project that the new project page has not
 * created yet.
 */

export type MeteredRunAction = "generation.run" | "doxabot.run"

/** Said under the estimate of a run that starts without a cache. */
export const COLD_RUN_SENTENCE = "No cache yet, so Doxabot reads the whole repository and plans the site from scratch."

/** What the estimate line shows once its data is known. */
export interface CreditEstimateView {
  /** "About 317–450 credits. Stops at 3,000." */
  sentence: string
  /** "About $2.40 from pay-as-you-go", or null. */
  paygSentence: string | null
  /** The trial credits left while the account is in the trial, else null. */
  trialCreditsLeft: number | null
  /** The note for a run whose cap is above the trial credits left, else null. */
  trialNote: string | null
}

const ESTIMATE_FACTOR_NUMERATOR = 3
const ESTIMATE_FACTOR_DENOMINATOR = 2

/**
 * The estimate of a run on a project that does not exist yet, so it has no
 * run history: the API's default estimate (`estimateRun` in
 * `@doxahq/billing`, the branch without history), with the account's cap
 * for the action, else the catalog's default cap.
 */
export function defaultRunEstimate(action: MeteredRunAction, detail: BillingAccountDetail | null): CreditEstimate {
  const pricing = DOXA_CATALOG.actions[action].pricing
  const cap = detail?.caps.find((entry) => entry.action === action)?.capCredits ?? pricing.defaultCap
  const usage = pricing.defaultEstimateCredits
  const lowUsage = Math.ceil((usage * ESTIMATE_FACTOR_DENOMINATOR) / ESTIMATE_FACTOR_NUMERATOR)
  return {
    action,
    low: Math.min(cap, pricing.base + lowUsage),
    high: Math.min(cap, pricing.base + usage),
    cap,
    source: "default",
  }
}

function trialCreditsLeft(detail: BillingAccountDetail | null): number | null {
  if (!detail || detail.subscription?.status !== "trialing") return null
  return creditMeterView(detail).left
}

/** "The trial has 640 credits, so the run stops there…", when the run may need more than the trial has left. */
export function trialCapNote(estimate: CreditEstimate, creditsLeft: number | null): string | null {
  if (creditsLeft === null || estimate.cap <= creditsLeft) return null
  return `The trial has ${formatCredits(creditsLeft)} credits, so the run stops there if it needs more. Finished pages stay on the draft branch, and you can continue it after you start Pro.`
}

export function creditEstimateView(estimate: CreditEstimate, detail: BillingAccountDetail | null): CreditEstimateView {
  const creditsLeft = trialCreditsLeft(detail)
  return {
    sentence: estimateSentence(estimate),
    paygSentence: estimatePaygSentence(estimate, detail),
    trialCreditsLeft: creditsLeft,
    trialNote: trialCapNote(estimate, creditsLeft),
  }
}

/**
 * Whether the next run of `action` on a project starts cold. A generation
 * that a person starts and a pull request run follow different baseline
 * rules, so the cache view answers both. Null when the cache is not known.
 */
export function isNextRunCold(cache: ProjectGenerationCache | null | undefined, action: MeteredRunAction): boolean | null {
  if (!cache) return null
  return action === "generation.run" ? cache.nextGenerationRunCold : cache.nextPullRequestRunCold
}

/** The estimate of the Doxabot page's pull request previews: the action the next run bills as, and its lead-in. */
export function pullRequestRunEstimate(cache: ProjectGenerationCache | null | undefined): {
  action: MeteredRunAction
  prefix: string
} {
  if (cache?.nextPullRequestRunCold) {
    return {
      action: cache.nextPullRequestRunAction,
      prefix: `Next pull request run starts cold: billed as a ${actionLabel("generation.run")}.`,
    }
  }
  return { action: cache?.nextPullRequestRunAction ?? "doxabot.run", prefix: "Each run:" }
}
