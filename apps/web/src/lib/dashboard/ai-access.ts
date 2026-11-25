import { DOXA_CATALOG } from "@doxahq/billing/catalog"
import type { BillingAccountList, ProjectBilling } from "@doxahq/contracts/billing"

import { workspaceBillingAccount } from "~/lib/dashboard/workspace-model"

/**
 * May the viewer start a Doxa Agent generation (catalog feature
 * `ai.doxa_agent`, billing spec 3 and 9.3)? The dashboard asks before it
 * offers a generation, so a Free account is not sent into a run it cannot
 * start. The API still enforces the feature.
 *
 * - `open`: billing enforcement is not `on` on this server (`off` and
 *   `shadow` never gate, even with a payment provider), or the plan has the
 *   feature (trial and Pro). The dashboard shows what it showed before billing.
 * - `needs_pro`: enforcement is `on` and the plan has no AI (Free). The
 *   dashboard shows the same actions, and a click on one opens the Pro trial
 *   dialog (`useProGate`) instead of running it.
 * - `loading`: the answer is not known yet. The caller reserves the space.
 */
export type AiGenerationAccess =
  | { kind: "loading" }
  | { kind: "open" }
  | { kind: "needs_pro"; accountId: string; canManage: boolean }

export const AI_ACCESS_LOADING: AiGenerationAccess = { kind: "loading" }
export const AI_ACCESS_OPEN: AiGenerationAccess = { kind: "open" }

const proTrial = DOXA_CATALOG.plans.pro.trial
const trialDays = proTrial?.days ?? 7

/** "Start 7-day Pro trial" */
export const PRO_TRIAL_ACTION = `Start ${trialDays}-day Pro trial`
/** Shown in the Pro trial dialog, after the reason, to a member who cannot manage billing. */
export const PRO_TRIAL_ASK_OWNER = "Ask an owner or admin of this account to start a Pro trial."

/** The reason lines of the Pro trial dialog for the actions that Free does not have. */
export const PRO_REASON_REPOSITORY = "A full generation from your repository needs Pro."
export const PRO_REASON_GENERATION = "Generating docs needs Pro."

/** What a Pro gate asks for: the reason line of the dialog and the feature's machine code for analytics. */
export interface ProGateReason {
  readonly feature: string
  readonly reason: string
}

export const PRO_GATE_REPOSITORY: ProGateReason = { feature: "repository_generation", reason: PRO_REASON_REPOSITORY }
export const PRO_GATE_GENERATION: ProGateReason = { feature: "generation", reason: PRO_REASON_GENERATION }

/**
 * True when the plan has the Doxa Agent. An unknown plan key (a newer API)
 * counts as true: the API decides, and the dashboard never hides a feature
 * that it cannot judge.
 */
export function planHasDoxaAgent(plan: string): boolean {
  const definition = DOXA_CATALOG.plans[plan as keyof typeof DOXA_CATALOG.plans]
  if (!definition) return true
  return definition.features["ai.doxa_agent"] !== false
}

/**
 * The access of a project that does not exist yet. A project made on the new
 * project page belongs to the current workspace (`teamId`, null for
 * Personal), so it bills to that workspace's account (spec 8.1).
 * `GET /billing/accounts` fails with 503 `billing_not_configured` while
 * billing is off; any failure keeps today's onboarding. An account that the
 * list does not show is left to the API.
 */
export function newProjectAiAccess(
  query: { isPending: boolean; data: BillingAccountList | undefined },
  teamId: string | null,
): AiGenerationAccess {
  if (query.data === undefined) return query.isPending ? AI_ACCESS_LOADING : AI_ACCESS_OPEN
  if (query.data.enforcement !== "on") return AI_ACCESS_OPEN
  const account = workspaceBillingAccount(query.data.accounts, teamId)
  if (!account || planHasDoxaAgent(account.plan)) return AI_ACCESS_OPEN
  return { kind: "needs_pro", accountId: account.id, canManage: account.canManage }
}

/**
 * The access of an existing project, from the `billing` field of
 * `GET /projects/:projectId` (null or missing while billing is off). Only
 * `enforcement: "on"` gates.
 */
export function projectAiAccess(input: {
  isPending: boolean
  billing: ProjectBilling | null | undefined
  canManageBilling: boolean
}): AiGenerationAccess {
  if (input.isPending) return AI_ACCESS_LOADING
  const billing = input.billing
  if (!billing || billing.enforcement !== "on" || planHasDoxaAgent(billing.plan)) return AI_ACCESS_OPEN
  return { kind: "needs_pro", accountId: billing.accountId, canManage: input.canManageBilling }
}
