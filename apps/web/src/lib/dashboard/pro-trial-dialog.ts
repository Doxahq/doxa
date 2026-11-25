import { createContext, useCallback, useContext } from "react"
import { useQuery } from "@tanstack/react-query"

import type { AiGenerationAccess, ProGateReason } from "~/lib/dashboard/ai-access"
import { billingOffersQueryOptions } from "~/lib/queries/billing"

/**
 * The one Pro trial dialog of the dashboard (billing spec 3, 15.2). It opens
 * only from a click: an action that Free does not have, or an API refusal of
 * such an action. `ProTrialDialogProvider` in the dashboard layout draws it.
 */
export interface ProTrialRequest {
  /** The billing account that the trial is for. */
  accountId: string
  /** False for a member who cannot manage billing: the dialog asks for an owner, with no Checkout. */
  canManage: boolean
  /** Why the action needs Pro, for example "Generating docs from a repository needs Pro." */
  reason: string
  /** The machine code of the feature, such as `generation` or a plan limit key, for the `pro_trial_dialog_opened` event. */
  feature: string
  /** A `/dashboard/...` path for Checkout to return to; by default the page the dialog is on. */
  returnPath?: string
}

export interface ProTrialDialogApi {
  open: (request: ProTrialRequest) => void
}

/** Without a provider (an isolated test or story), `open` does nothing. */
export const ProTrialDialogContext = createContext<ProTrialDialogApi>({ open: () => undefined })

export function useProTrialDialog(): ProTrialDialogApi {
  return useContext(ProTrialDialogContext)
}

/**
 * The dialog request of a click on an action that needs Pro, or null when the
 * action runs: billing off or shadow, trial and Pro are `open`, and `loading`
 * leaves the answer to the API (a 403 opens the dialog then).
 */
export function proTrialRequest(access: AiGenerationAccess, gate: ProGateReason, returnPath?: string): ProTrialRequest | null {
  if (access.kind !== "needs_pro") return null
  return {
    accountId: access.accountId,
    canManage: access.canManage,
    reason: gate.reason,
    feature: gate.feature,
    ...(returnPath ? { returnPath } : {}),
  }
}

/**
 * A gate for the actions that need Pro. Call it first in the click handler:
 * it returns true when it opened the Pro trial dialog, and the handler then
 * stops. For a Free account the Pro prices load next to the page, so the
 * dialog draws its final price in its first frame.
 */
export function useProGate(access: AiGenerationAccess): (gate: ProGateReason, returnPath?: string) => boolean {
  const dialog = useProTrialDialog()
  useQuery({ ...billingOffersQueryOptions(), enabled: access.kind === "needs_pro" })
  return useCallback(
    (gate: ProGateReason, returnPath?: string) => {
      const request = proTrialRequest(access, gate, returnPath)
      if (!request) return false
      dialog.open(request)
      return true
    },
    [access, dialog],
  )
}
