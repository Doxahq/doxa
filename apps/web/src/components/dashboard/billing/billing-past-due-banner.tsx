import { AlertTriangle, Loader2 } from "lucide-react"

import { Button } from "~/components/ui/button"

/**
 * The past-due banner (spec 15.2): a tinted strip, never a colored left
 * border, with one action that opens the Portal's card update flow.
 */
export function BillingPastDueBanner({
  canManage,
  isPending,
  error,
  onUpdateCard,
}: {
  canManage: boolean
  isPending: boolean
  error: string | null
  onUpdateCard: () => void
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 border border-destructive/40 bg-destructive/8 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">A payment failed</p>
          <p className="text-[13px] leading-5 text-muted-foreground">
            {canManage
              ? "Update the payment method. AI actions above the monthly credits stay paused until the invoice is paid."
              : "Ask an owner or admin of this account to update the payment method."}
          </p>
          {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        </div>
      </div>
      {canManage ? (
        <Button size="sm" className="w-fit shrink-0" disabled={isPending} onClick={onUpdateCard}>
          {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Update the card
        </Button>
      ) : null}
    </div>
  )
}
