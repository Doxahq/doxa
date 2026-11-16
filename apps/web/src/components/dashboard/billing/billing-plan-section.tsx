import { useState, type ReactNode } from "react"
import { ExternalLink, Loader2 } from "lucide-react"
import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { BillingIntervalSwitchDialog } from "~/components/dashboard/billing/billing-interval-switch-dialog"
import { BillingStatusBadge } from "~/components/dashboard/billing/billing-status-badge"
import { StartProNowDialog } from "~/components/dashboard/billing/start-pro-now-dialog"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { isFounderPrice, switchTargetPrice } from "~/lib/dashboard/billing-model"
import { planCardView, type PlanCardView } from "~/lib/dashboard/billing-plan-view"

export interface PlanSectionActions {
  /** Opens the Portal on its cancel flow. */
  onCancel: () => void
  /** Opens the Portal, for a plan that ends at the period end. */
  onManage: () => void
  isPortalPending: boolean
  portalError: string | null
  onSwitchInterval: (interval: "month" | "year", idempotencyKey: string) => Promise<unknown>
  isSwitchPending: boolean
  switchError: string | null
}

/**
 * PLAN: the plan, its status and price, the renewal or the trial end, and the
 * actions of the state: Start Pro now during the trial (decision D22), the
 * monthly/yearly switch, and Cancel, which opens the Portal.
 */
export function BillingPlanSection({ detail, actions }: { detail: BillingAccountDetail; actions: PlanSectionActions }) {
  const view = planCardView(detail)
  const [dialog, setDialog] = useState<"switch" | "start" | null>(null)
  const subscription = detail.subscription
  const target = subscription ? switchTargetPrice(subscription.priceKey) : null
  const canSwitch = target !== null && (view.state === "active" || view.state === "trial")

  const buttons = detail.canManage ? (
    <PlanButtons
      view={view}
      switchLabel={target?.interval === "year" ? "Switch to yearly" : "Switch to monthly"}
      canSwitch={canSwitch}
      actions={actions}
      onStartPro={() => setDialog("start")}
      onSwitch={() => setDialog("switch")}
    />
  ) : null
  const buttonsBelow = view.state === "trial"

  return (
    <section className="flex flex-col gap-3" aria-labelledby="billing-plan">
      <SectionLabel>
        <span id="billing-plan">Plan</span>
      </SectionLabel>
      <div className="surface-card">
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5 sm:px-6">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-lg font-semibold text-foreground">{view.name}</span>
              {view.badges.map((badge) => (
                <BillingStatusBadge key={badge.label} label={badge.label} tone={badge.tone} />
              ))}
              {view.state === "free" && view.headline ? (
                <span className="text-sm text-muted-foreground">{view.headline}</span>
              ) : null}
            </div>
            {view.state !== "free" && view.headline ? <span className="text-sm text-foreground">{view.headline}</span> : null}
            {view.note ? <span className="text-[13.5px] text-muted-foreground">{view.note}</span> : null}
            {buttonsBelow && buttons ? <div className="pt-2.5">{buttons}</div> : null}
          </div>
          {!buttonsBelow ? buttons : null}
        </div>
        {view.footnote ? (
          <p className="border-t border-divider px-5 py-3 text-[13.5px] text-muted-foreground sm:px-6">{view.footnote}</p>
        ) : null}
      </div>
      {actions.portalError ? (
        <Alert variant="destructive">
          <AlertDescription>{actions.portalError}</AlertDescription>
        </Alert>
      ) : null}
      {target && subscription ? (
        <BillingIntervalSwitchDialog
          accountId={detail.id}
          target={target}
          isFounder={isFounderPrice(subscription.priceKey)}
          open={dialog === "switch"}
          onOpenChange={(open) => setDialog(open ? "switch" : null)}
          isPending={actions.isSwitchPending}
          error={actions.switchError}
          onConfirm={actions.onSwitchInterval}
        />
      ) : null}
      {/* Kept while open: after a 409 the account refreshes out of its trial, and the dialog still shows why. */}
      {view.state === "trial" || dialog === "start" ? (
        <StartProNowDialog accountId={detail.id} open={dialog === "start"} onOpenChange={(open) => setDialog(open ? "start" : null)} />
      ) : null}
    </section>
  )
}

function PlanButtons({
  view,
  switchLabel,
  canSwitch,
  actions,
  onStartPro,
  onSwitch,
}: {
  view: PlanCardView
  switchLabel: string
  canSwitch: boolean
  actions: PlanSectionActions
  onStartPro: () => void
  onSwitch: () => void
}) {
  const list: ReactNode[] = []
  if (view.state === "trial") {
    list.push(
      <Button key="start" size="sm" onClick={onStartPro}>
        Start Pro now
      </Button>,
    )
  }
  if (canSwitch) {
    list.push(
      <Button key="switch" variant="outline" size="sm" onClick={onSwitch}>
        {switchLabel}
      </Button>,
    )
  }
  if (view.state === "trial" || view.state === "active") {
    list.push(
      <PortalButton key="cancel" isPending={actions.isPortalPending} onClick={actions.onCancel}>
        {view.state === "trial" ? "Cancel trial" : "Cancel plan"}
      </PortalButton>,
    )
  }
  if (view.state === "canceled") {
    list.push(
      <PortalButton key="manage" isPending={actions.isPortalPending} onClick={actions.onManage} icon>
        Manage in Stripe
      </PortalButton>,
    )
  }
  if (list.length === 0) return null
  return <div className="flex flex-wrap gap-2">{list}</div>
}

function PortalButton({
  isPending,
  onClick,
  icon = false,
  children,
}: {
  isPending: boolean
  onClick: () => void
  icon?: boolean
  children: ReactNode
}) {
  return (
    <Button variant="outline" size="sm" disabled={isPending} onClick={onClick}>
      {isPending ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : icon ? (
        <ExternalLink aria-hidden="true" />
      ) : null}
      {children}
    </Button>
  )
}
