import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"

import { BillingPreviewRows, BillingPreviewRowsSkeleton } from "~/components/dashboard/billing/billing-preview-rows"
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
import type { SwitchTarget } from "~/lib/dashboard/billing-model"
import { switchBalanceNote, switchDialogCopy, switchPreviewRows } from "~/lib/dashboard/billing-plan-change"
import { billingPlanIntervalPreviewQueryOptions } from "~/lib/queries/billing"

/**
 * The monthly/yearly switch (spec 13). While it is open, it reads the
 * provider's preview: the credit for the unused time, the first period, and
 * the charge today, then the note that the balance is not a refund. When the
 * preview fails, it shows the plain confirm text. The switch keeps one
 * idempotency key for each opening, so a retry of the same click is safe.
 */
export function BillingIntervalSwitchDialog({
  accountId,
  target,
  isFounder,
  open,
  onOpenChange,
  isPending,
  error,
  onConfirm,
}: {
  accountId: string
  target: SwitchTarget
  isFounder: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  isPending: boolean
  error: string | null
  onConfirm: (interval: "month" | "year", idempotencyKey: string) => Promise<unknown>
}) {
  const copy = switchDialogCopy(target, isFounder)
  const preview = useQuery({ ...billingPlanIntervalPreviewQueryOptions(accountId, target.interval), enabled: open })
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  // A closed dialog takes a new key, so the next opening is a new switch.
  function close(): void {
    setIdempotencyKey(crypto.randomUUID())
    onOpenChange(false)
  }

  function change(next: boolean): void {
    if (isPending) return
    if (next) onOpenChange(true)
    else close()
  }

  async function confirm(): Promise<void> {
    try {
      await onConfirm(target.interval, idempotencyKey)
      close()
    } catch {
      // The dialog shows the error.
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="shadow-none">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {preview.isPending ? (
            <BillingPreviewRowsSkeleton count={3} />
          ) : preview.data ? (
            <>
              <BillingPreviewRows rows={switchPreviewRows(preview.data)} />
              <p className="text-[13.5px] leading-5 text-muted-foreground">{switchBalanceNote(preview.data)}</p>
            </>
          ) : (
            <p className="text-[13.5px] leading-5 text-muted-foreground">{copy.fallback}</p>
          )}
          {error ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={isPending} onClick={() => change(false)}>
            {copy.keepLabel}
          </Button>
          <Button size="sm" disabled={isPending} onClick={() => void confirm()}>
            {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {copy.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
