import { useMemo, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowUpRight, Check, CreditCard, Loader2 } from "lucide-react"
import type { BillingInterval } from "@doxahq/billing/catalog"

import { BillingIntervalControl } from "~/components/dashboard/billing/billing-interval-control"
import { OfferClosedDialog } from "~/components/dashboard/billing/offer-closed-dialog"
import { Bar, TextBar } from "~/components/dashboard/skeletons/skeleton-kit"
import { Alert, AlertDescription } from "~/components/ui/alert"
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
import { PRO_TRIAL_ACTION, PRO_TRIAL_ASK_OWNER } from "~/lib/dashboard/ai-access"
import { founderOffer } from "~/lib/dashboard/billing-model"
import { ProTrialDialogContext, type ProTrialDialogApi, type ProTrialRequest } from "~/lib/dashboard/pro-trial-dialog"
import {
  PRO_NO_TRIAL_LINE,
  PRO_TRIAL_CANCEL_LINE,
  PRO_TRIAL_TERMS,
  PRO_TRIAL_TITLE,
  PRO_UPGRADE_ACTION,
  PRO_UPGRADE_TITLE,
  proOfferPriceView,
} from "~/lib/dashboard/pro-trial-offer"
import { useProTrialCheckout } from "~/lib/dashboard/use-ai-access"
import { getErrorMessage } from "~/lib/errors"
import { billingAccountQueryOptions, billingOffersQueryOptions } from "~/lib/queries/billing"
import { PRO_FEATURE_GROUPS, type ProFeatureGroup } from "~/lib/marketing/pricing"

/**
 * Holds the one Pro trial dialog of the dashboard. `useProTrialDialog().open`
 * opens it, and only a click calls that (see `useProGate`).
 */
export function ProTrialDialogProvider({ children }: { children: ReactNode }) {
  // A new key for each open: the dialog starts on Yearly again, with its own Checkout state.
  const [current, setCurrent] = useState<{ key: number; request: ProTrialRequest } | null>(null)
  const api = useMemo<ProTrialDialogApi>(
    () => ({
      open: (request) => {
        captureBrowserEvent("pro_trial_dialog_opened", { feature: request.feature })
        setCurrent((previous) => ({ key: (previous?.key ?? 0) + 1, request }))
      },
    }),
    [],
  )
  return (
    <ProTrialDialogContext.Provider value={api}>
      {children}
      {current ? <ProTrialDialog key={current.key} request={current.request} onClose={() => setCurrent(null)} /> : null}
    </ProTrialDialogContext.Provider>
  )
}

/**
 * "This needs Pro. Try Pro free for 7 days": the reason of the caller, the
 * Monthly / Yearly choice (Yearly first), the price of that interval from
 * `GET /billing/offers`, the Pro features in two groups and the trial terms. "Start 7-day
 * Pro trial" opens Checkout for the chosen interval; "Not now" only closes.
 * A member who cannot manage billing sees who can start the trial instead.
 */
export function ProTrialDialog({ request, onClose }: { request: ProTrialRequest; onClose: () => void }) {
  const [interval, setInterval] = useState<BillingInterval>("year")
  const offers = useQuery({ ...billingOffersQueryOptions(), enabled: request.canManage })
  // Only an account that never had a subscription gets the trial (the trial rule of Checkout).
  const account = useQuery({ ...billingAccountQueryOptions(request.accountId), enabled: request.canManage })
  // The trial copy stays while the account loads: most accounts that see this dialog never subscribed.
  const trialAvailable = account.data?.trialAvailable ?? true
  const trial = useProTrialCheckout(request.accountId, request.returnPath, interval)
  const view = proOfferPriceView(founderOffer(offers.data ?? []), interval)
  const pricePending = request.canManage && (offers.isPending || account.isPending)

  return (
    <>
      <Dialog open onOpenChange={(open) => (!open && !trial.isPending ? onClose() : undefined)}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-3xl flex-col overscroll-contain shadow-none">
          <DialogHeader>
            <span className="font-mono text-[11px] tracking-[0.14em] text-label uppercase">Doxa Pro</span>
            <DialogTitle className="text-balance">{trialAvailable ? PRO_TRIAL_TITLE : PRO_UPGRADE_TITLE}</DialogTitle>
            <DialogDescription className="text-pretty">{request.reason}</DialogDescription>
          </DialogHeader>

          <DialogBody className="flex min-h-0 flex-col gap-6 overflow-y-auto scrollbar-subtle">
            {request.canManage ? (
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-1" aria-busy={pricePending || undefined}>
                  {pricePending ? (
                    <PriceSkeleton />
                  ) : (
                    <>
                      {view.amount ? (
                        <p className="flex items-baseline gap-1.5">
                          <span className="font-mono text-3xl font-bold text-foreground">{view.amount}</span>
                          <span className="text-sm text-muted-foreground">{trialAvailable ? "/ month after the trial" : "/ month"}</span>
                        </p>
                      ) : null}
                      <p className="text-[13px] text-muted-foreground">{view.billedLine}</p>
                      {view.founderLine ? <p className="text-[13px] text-primary-text">{view.founderLine}</p> : null}
                    </>
                  )}
                </div>
                <BillingIntervalControl value={interval} onChange={setInterval} yearlySavingsPercent={view.yearlySavingsPercent} />
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                {PRO_FEATURE_GROUPS.map((group) => (
                  <ProFeatureList key={group.id} group={group} />
                ))}
              </div>
              <ComparePlansLink />
            </div>

            {request.canManage && trialAvailable ? <TrialTerms firstCharge={pricePending ? null : view.firstCharge} /> : null}

            {trial.error ? (
              <Alert variant="destructive" aria-live="polite">
                <AlertDescription>{getErrorMessage(trial.error, "Could not open Checkout.")}</AlertDescription>
              </Alert>
            ) : null}
          </DialogBody>

          <DialogFooter className="sm:items-center">
            {/* Above the buttons on a phone, at their left from sm up. */}
            <p className="order-last text-[13px] leading-5 text-label sm:order-none sm:mr-auto">
              {request.canManage ? (trialAvailable ? PRO_TRIAL_CANCEL_LINE : PRO_NO_TRIAL_LINE) : PRO_TRIAL_ASK_OWNER}
            </p>
            <Button type="button" variant="ghost" disabled={trial.isPending} onClick={onClose}>
              Not now
            </Button>
            {request.canManage ? (
              <Button
                type="button"
                disabled={trial.isPending || pricePending}
                onClick={() => {
                  captureBrowserEvent("upgrade_clicked", { location: "pro_trial_dialog", interval })
                  trial.start()
                }}
              >
                {trial.isPending ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <CreditCard aria-hidden="true" />
                )}
                {trialAvailable ? PRO_TRIAL_ACTION : PRO_UPGRADE_ACTION}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <OfferClosedDialog
        priceKey={trial.closedPriceKey}
        isPending={trial.isPending}
        onCancel={trial.cancelClosedOffer}
        onAccept={trial.acceptClosedOffer}
      />
    </>
  )
}

/**
 * Today, in the trial, and when it ends: a bordered muted panel whose terms
 * sit side by side from sm up and stack on a phone. `firstCharge` is null
 * while the price loads.
 */
function TrialTerms({ firstCharge }: { firstCharge: string | null }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-divider bg-sidebar px-4 py-3.5 sm:grid-cols-3">
      <TrialTerm label={PRO_TRIAL_TERMS.today}>{PRO_TRIAL_TERMS.todayValue}</TrialTerm>
      <TrialTerm label={PRO_TRIAL_TERMS.inTrial}>{PRO_TRIAL_TERMS.inTrialValue}</TrialTerm>
      <TrialTerm label={PRO_TRIAL_TERMS.afterTrial}>
        {firstCharge ?? <TextBar width="9rem" className="text-sm" />}
      </TrialTerm>
    </dl>
  )
}

function TrialTerm({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="font-mono text-[11px] tracking-[0.14em] text-label uppercase">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  )
}

/** The pricing page in a new tab, so the dialog and its Checkout stay open here. */
function ComparePlansLink() {
  return (
    <Link
      to="/pricing"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Compare plans (opens in a new tab)"
      className="inline-flex w-fit items-center gap-1 text-[13px] text-primary-text underline-offset-4 hover:underline"
    >
      Compare plans
      <ArrowUpRight aria-hidden="true" className="size-3.5" />
    </Link>
  )
}

/** One labeled group of Pro features. An item never wraps, so both columns keep one line per feature. */
function ProFeatureList({ group }: { group: ProFeatureGroup }) {
  const labelId = `pro-features-${group.id}`
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <span id={labelId} className="font-mono text-[11px] tracking-[0.14em] text-label uppercase">
        {group.label}
      </span>
      <ul aria-labelledby={labelId} className="flex flex-col gap-2.5 text-sm text-body">
        {group.items.map((item) => (
          <li key={item} className="flex items-center gap-2 whitespace-nowrap">
            <Check aria-hidden="true" className="size-4 shrink-0 text-label" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The amount, billed and founder lines' boxes, so the price takes its final space. */
function PriceSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-1">
      <Bar width="7rem" height="2.25rem" />
      <TextBar width="10rem" className="text-[13px]" />
      <TextBar width="14rem" className="text-[13px]" />
    </div>
  )
}
