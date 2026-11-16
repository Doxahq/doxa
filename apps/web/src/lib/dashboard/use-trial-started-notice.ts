import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import type { AiGenerationAccess } from "~/lib/dashboard/ai-access"
import {
  TRIAL_NOTICE_NONE,
  TRIAL_NOTICE_PENDING,
  trialStartedLine,
  type TrialStartedNotice,
} from "~/lib/dashboard/trial-started-notice"
import { billingAccountQueryOptions, billingAccountsQueryOptions } from "~/lib/queries/billing"

/**
 * The trial notice of one visit of the new project page. Only a visit that
 * arrived with `?checkout=<id>` shows it: the flag is read once, so it stays
 * after the page drops the parameter, and a reload (with no parameter) never
 * shows it again.
 *
 * `access` is the page's AI access: `loading` while the Checkout return waits
 * for the plan. The values come from the personal account's detail, which
 * the Checkout sync writes to the cache.
 */
export function useTrialStartedNotice(checkoutSessionId: string | null, access: AiGenerationAccess): TrialStartedNotice {
  const [fromCheckout] = useState(() => checkoutSessionId !== null)
  const accounts = useQuery({ ...billingAccountsQueryOptions(), enabled: fromCheckout })
  const accountId = accounts.data?.accounts.find((account) => account.ownerKind === "user")?.id ?? null
  const detail = useQuery({ ...billingAccountQueryOptions(accountId ?? ""), enabled: fromCheckout && accountId !== null && access.kind === "open" })

  if (!fromCheckout || access.kind === "needs_pro") return TRIAL_NOTICE_NONE
  if (access.kind === "loading") return TRIAL_NOTICE_PENDING
  if (accountId === null) return TRIAL_NOTICE_NONE
  if (detail.isPending) return TRIAL_NOTICE_PENDING
  const line = detail.data ? trialStartedLine(detail.data) : null
  return line ? { kind: "shown", line } : TRIAL_NOTICE_NONE
}
