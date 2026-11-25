import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { CreditsExhaustedErrorDetails, PlanLimitErrorDetails } from "@doxahq/contracts/billing"

import { PlanLimitGate } from "~/components/dashboard/content/site-settings/fields/entitlement-gate"
import { StartProNowContent } from "~/components/dashboard/billing/start-pro-now-dialog"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { captureBrowserEvent } from "~/lib/analytics/capture-browser-event"
import { createBillingPortal, updateBillingPayg } from "~/lib/billing-api"
import {
  CREDITS_EXHAUSTED_COPY,
  formatBillingDate,
  formatCredits,
  planLimitSentence,
  stoppedRunLines,
  type CreditsExhaustedAction,
  type StoppedRunSummary,
} from "~/lib/dashboard/billing-model"
import { showBillingDenial, useBillingDenial } from "~/lib/dashboard/billing-denials"
import { openBillingUrl } from "~/lib/dashboard/use-billing-account"
import { usePlanLimitRouting } from "~/lib/dashboard/use-plan-limit-routing"
import { getErrorMessage } from "~/lib/errors"
import { billingQueryKeys } from "~/lib/queries/billing"

/** The body of the 402 dialog for one `reason` (spec 10.6), with the stopped run when the caller knows it. */
export function CreditsExhaustedContent({
  details,
  run = null,
  isPending,
  error,
  onAction,
  onClose,
}: {
  details: CreditsExhaustedErrorDetails
  run?: StoppedRunSummary | null
  isPending: boolean
  error: string | null
  onAction: (action: CreditsExhaustedAction) => void
  onClose: () => void
}) {
  const copy = CREDITS_EXHAUSTED_COPY[details.reason]
  const secondary = copy.secondary
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <DialogDescription>{copy.body}</DialogDescription>
        {run ? <StoppedRunCard run={run} /> : null}
        <p className="text-[13px] text-muted-foreground">
          {/* No "the run needs about N": that is the run estimate, hidden until it is reliable. */}
          {formatCredits(Math.max(0, details.available))} credits available.
          {details.resetsAt && details.reason !== "max_debt" ? ` Monthly credits reset on ${formatBillingDate(details.resetsAt)}.` : null}
        </p>
        {copy.note ? <p className="text-[13px] text-muted-foreground">{copy.note}</p> : null}
        {error ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={() => (secondary.action ? onAction(secondary.action) : onClose())}
        >
          {secondary.label}
        </Button>
        <Button size="sm" disabled={isPending} onClick={() => onAction(copy.action)}>
          {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {copy.actionLabel}
        </Button>
      </DialogFooter>
    </>
  )
}

/** The run that stopped: its kind, repository and pages, and where the finished pages are. */
function StoppedRunCard({ run }: { run: StoppedRunSummary }) {
  const lines = stoppedRunLines(run)
  return (
    <div className="surface-card flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-[13.5px] font-medium text-foreground">{lines.title}</span>
          {lines.source ? <span className="min-w-0 truncate font-mono text-[12.5px] text-muted-foreground">{lines.source}</span> : null}
        </span>
        <Badge variant="warning" className="shrink-0">
          Stopped · credits
        </Badge>
      </div>
      {lines.pages ? <p className="text-[13px] text-body">{lines.pages}</p> : null}
      <p className="text-[13px] text-muted-foreground">Finished pages stay on the draft branch.</p>
    </div>
  )
}

/** The body of the 403 `plan_limit` dialog: the limit, the use, one action. */
export function PlanLimitContent({ details, onClose }: { details: PlanLimitErrorDetails; onClose: () => void }) {
  const href = details.upgradeUrl ?? "/dashboard/billing"
  return (
    <>
      <DialogHeader>
        <DialogTitle>Plan limit reached</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <DialogDescription>Upgrade the plan of this account to continue.</DialogDescription>
        <PlanLimitGate
          sentence={planLimitSentence(details)}
          action={
            <Button size="sm" asChild>
              <a href={href} onClick={() => captureBrowserEvent("upgrade_clicked", { location: "plan_limit_dialog" })}>
                Upgrade
              </a>
            </Button>
          }
        />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Draws the last billing denial of any mutation (see `billing-denials.ts`).
 * The dashboard layout mounts it once, inside `ProTrialDialogProvider`: a 403
 * that the Pro trial unlocks on a Free account opens the Pro trial dialog
 * instead of "Plan limit reached" (`usePlanLimitRouting`).
 */
export function BillingDenialDialogHost() {
  const denial = useBillingDenial()
  const showPlanLimit = usePlanLimitRouting(denial)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const accountId = denial?.kind === "credits" ? denial.details.accountId : null
  // Start Pro now (decision D22) turns the dialog into its confirm step.
  const [startingPro, setStartingPro] = useState(false)

  const action = useMutation({
    mutationFn: async (next: CreditsExhaustedAction) => {
      if (!accountId) return
      if (next === "update_card") {
        openBillingUrl(await createBillingPortal(accountId, "payment_method_update"))
        return
      }
      if (next === "turn_on_payg") {
        await updateBillingPayg(accountId, { enabled: true })
        await queryClient.invalidateQueries({ queryKey: billingQueryKeys.account(accountId) })
        toast.success("Pay-as-you-go is on. Start the run again.")
        close()
        return
      }
      close()
      // The monthly limit is on AI credits; "View billing" opens Plan and invoices.
      if (next === "raise_limit") {
        await navigate({ to: "/dashboard/billing/$accountId/credits", params: { accountId }, hash: "payg" })
        return
      }
      await navigate({ to: "/dashboard/billing/$accountId", params: { accountId } })
    },
  })

  function close(): void {
    action.reset()
    setStartingPro(false)
    showBillingDenial(null)
  }

  return (
    <Dialog open={denial?.kind === "credits" || showPlanLimit} onOpenChange={(open) => (!open && !action.isPending ? close() : undefined)}>
      <DialogContent className="shadow-none">
        {denial?.kind === "credits" && startingPro ? (
          <StartProNowContent
            accountId={denial.details.accountId}
            onCancel={() => setStartingPro(false)}
            cancelLabel="Back"
            onDone={close}
          />
        ) : denial?.kind === "credits" ? (
          <CreditsExhaustedContent
            details={denial.details}
            run={denial.run ?? null}
            isPending={action.isPending}
            error={action.error ? getErrorMessage(action.error, "Something went wrong.") : null}
            onAction={(next) => {
              if (next !== "start_pro_now") {
                action.mutate(next)
                return
              }
              captureBrowserEvent("upgrade_clicked", { location: "credits_dialog_start_pro_now" })
              setStartingPro(true)
            }}
            onClose={close}
          />
        ) : denial?.kind === "plan_limit" && showPlanLimit ? (
          <PlanLimitContent details={denial.details} onClose={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
