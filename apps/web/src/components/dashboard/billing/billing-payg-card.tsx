import { useState, type FormEvent } from "react"
import { ExternalLink, Loader2 } from "lucide-react"
import type { BillingAccountDetail, BillingInvoice } from "@doxahq/contracts/billing"

import { FieldList, FieldRow, SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import { BillingStatusBadge, MeterBar } from "~/components/dashboard/billing/billing-status-badge"
import { Switch } from "~/components/dashboard/content/site-settings/fields/controls"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import {
  PAYG_CHARGE_SENTENCE,
  formatBillingDate,
  formatCents,
  formatCredits,
  parseMonthlyLimit,
  paygView,
} from "~/lib/dashboard/billing-model"

export interface PaygCardActions {
  onChange: (input: { enabled?: boolean; monthlyLimitCents?: number }) => Promise<unknown>
  isPending: boolean
  error: string | null
}

/**
 * The pay-as-you-go card (spec 10.10, 15.2): the debt, the automatic charge
 * sentence, the next monthly charge, "Charge in progress", the past charges,
 * the month total against the limit, the limit and the on/off setting. It has
 * no Pay now button (decision D19).
 */
export function BillingPaygCard({
  detail,
  invoices,
  actions,
}: {
  detail: BillingAccountDetail
  invoices: readonly BillingInvoice[]
  actions: PaygCardActions
}) {
  const view = paygView(detail, invoices)
  const { payg } = detail
  // The setting matters only when nothing else holds pay-as-you-go off (plan, trial, failed charge, dispute).
  const canToggle = detail.canManage && (payg.offReason === null || payg.offReason === "setting_off")

  return (
    <section id="payg" className="flex flex-col gap-3" aria-labelledby="billing-payg">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <SectionLabel>
            <span id="billing-payg">Pay-as-you-go</span>
          </SectionLabel>
          <SectionDescription>
            Above the monthly credits, runs continue at $0.01 per credit. {PAYG_CHARGE_SENTENCE}
          </SectionDescription>
        </div>
        {canToggle ? (
          <span className="mt-0.5 flex shrink-0 items-center gap-2">
            <Loader2
              aria-hidden="true"
              className={
                actions.isPending ? "size-4 animate-spin text-muted-foreground" : "invisible size-4"
              }
            />
            <Switch
              aria-label="Pay-as-you-go"
              checked={payg.enabled}
              disabled={actions.isPending}
              onCheckedChange={(enabled) => void actions.onChange({ enabled }).catch(() => undefined)}
            />
          </span>
        ) : null}
      </div>

      {view.paymentFailed ? (
        <div role="alert" className="flex flex-col gap-3 border border-destructive/40 bg-destructive/8 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-5 text-foreground">{view.offText}</p>
          {view.unpaidInvoice?.hostedInvoiceUrl ? (
            <Button size="sm" className="w-fit shrink-0" asChild>
              <a href={view.unpaidInvoice.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                Pay invoice
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          ) : null}
        </div>
      ) : view.offText ? (
        <p className="border border-border bg-secondary px-4 py-3 text-[13px] leading-5 text-body">{view.offText}</p>
      ) : null}

      <FieldList>
        <FieldRow label="Balance">
          <span className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[13.5px]">{view.debtUsd}</span>
            <span className="text-[13px] text-muted-foreground">({formatCredits(payg.debt)} credits)</span>
            {view.chargeInProgress ? <BillingStatusBadge label="Charge in progress" tone="warning" /> : null}
          </span>
        </FieldRow>
        <FieldRow label="This month">
          <span className="flex flex-col gap-2">
            <span>
              <span className="font-mono text-[13.5px]">{view.monthTotalUsd}</span>
              <span className="text-[13px] text-muted-foreground"> of {view.monthlyLimitUsd} monthly limit</span>
            </span>
            <MeterBar percent={view.percentOfLimit} tone={view.percentOfLimit >= 80 ? "warning" : "primary"} label="Monthly limit used" />
          </span>
        </FieldRow>
        <FieldRow label="Monthly limit" truncate={false}>
          {detail.canManage ? (
            <MonthlyLimitForm
              key={payg.monthlyLimitCents}
              currentCents={payg.monthlyLimitCents}
              rangeCents={view.rangeCents}
              isPending={actions.isPending}
              onSave={(cents) => actions.onChange({ monthlyLimitCents: cents })}
            />
          ) : (
            <span className="font-mono text-[13.5px]">{view.monthlyLimitUsd}</span>
          )}
        </FieldRow>
        <FieldRow label="Next charge">
          <span className="text-[14px] whitespace-normal">{view.nextSweepLine}</span>
        </FieldRow>
      </FieldList>
      {actions.error ? <p className="text-[13px] text-destructive">{actions.error}</p> : null}

      <PastCharges charges={view.pastCharges} />
    </section>
  )
}

const MONTHLY_LIMIT_ERROR_ID = "payg-monthly-limit-error"

function MonthlyLimitForm({
  currentCents,
  rangeCents,
  isPending,
  onSave,
}: {
  currentCents: number
  rangeCents: readonly [number, number]
  isPending: boolean
  onSave: (cents: number) => Promise<unknown>
}) {
  const [value, setValue] = useState(String(currentCents / 100))
  const [error, setError] = useState<string | null>(null)
  const parsed = parseMonthlyLimit(value, rangeCents)
  // Save stays on for an invalid value, so a click explains the range.
  const changed = "error" in parsed || parsed.cents !== currentCents

  function submit(event: FormEvent): void {
    event.preventDefault()
    if ("error" in parsed) {
      setError(parsed.error)
      return
    }
    setError(null)
    void onSave(parsed.cents).catch(() => undefined)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <span className="relative">
          <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
            $
          </span>
          <Input
            aria-label="Monthly limit in dollars"
            inputMode="numeric"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="h-8 w-24 pl-6"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? MONTHLY_LIMIT_ERROR_ID : undefined}
          />
        </span>
        <Button type="submit" variant="outline" size="sm" disabled={isPending || !changed}>
          Save
        </Button>
      </span>
      <span className="text-xs text-muted-foreground">
        From {formatCents(rangeCents[0]).replace(".00", "")} to {formatCents(rangeCents[1]).replace(".00", "")}. At the limit, runs stop until next month.
      </span>
      {error ? (
        <p id={MONTHLY_LIMIT_ERROR_ID} role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}

function PastCharges({ charges }: { charges: readonly BillingInvoice[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">Past charges</span>
      {charges.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No pay-as-you-go charges yet.</p>
      ) : (
        <ul className="surface-card">
          {charges.map((charge) => (
            <li
              key={charge.invoiceId}
              className="flex items-center justify-between gap-4 border-t border-divider px-5 py-3 text-[13.5px] first:border-t-0"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="text-muted-foreground">{formatBillingDate(charge.createdAt)}</span>
                <span className="font-mono text-foreground">{formatCents(charge.amountPaidCents)}</span>
                <span className="text-muted-foreground">{formatCredits(charge.usageCredits)} credits</span>
              </span>
              {charge.hostedInvoiceUrl || charge.pdfUrl ? (
                <a
                  href={charge.hostedInvoiceUrl ?? charge.pdfUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[13px] text-primary-text underline-offset-4 hover:underline"
                >
                  Invoice
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
