import { useQuery } from "@tanstack/react-query"
import { ExternalLink, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { SkeletonRegion, TextBar } from "~/components/dashboard/skeletons/skeleton-kit"
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
import { START_PRO_NOW_TITLE, startProNowFailure, startProNowSentence } from "~/lib/dashboard/billing-plan-change"
import { getErrorMessage } from "~/lib/errors"
import { useBillingPortal, useStartProNow } from "~/lib/dashboard/use-billing-account"
import { billingStartProNowPreviewQueryOptions } from "~/lib/queries/billing"

/**
 * The confirm step of Start Pro now (decision D22), for any dialog: the
 * charge from the provider's preview, then the charge itself. A declined card
 * (402 `payment_failed`) shows the card error and "Update in Stripe"; a trial
 * that already ended (409) says so, and the account refreshes.
 */
export function StartProNowContent({
  accountId,
  cancelLabel = "Not now",
  onCancel,
  onDone,
}: {
  accountId: string
  cancelLabel?: string
  onCancel: () => void
  onDone: () => void
}) {
  const preview = useQuery(billingStartProNowPreviewQueryOptions(accountId))
  const start = useStartProNow(accountId)
  const portal = useBillingPortal(accountId)
  const failure = start.error ? startProNowFailure(start.error) : null

  function confirm(): void {
    start.mutate(undefined, {
      onSuccess: () => {
        toast.success("Pro started. Your monthly AI credits are ready.")
        onDone()
      },
    })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{START_PRO_NOW_TITLE}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {preview.isPending ? (
          <SkeletonRegion label="Loading the charge" className="flex flex-col gap-1">
            <TextBar width="100%" className="text-sm leading-6" />
            <TextBar width="60%" className="text-sm leading-6" />
          </SkeletonRegion>
        ) : (
          <DialogDescription className="text-sm leading-6">{startProNowSentence(preview.data ?? null)}</DialogDescription>
        )}
        {failure ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertDescription className="flex flex-col gap-3">
              <span>{failure.message}</span>
              {failure.kind === "payment_failed" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  disabled={portal.isPending}
                  onClick={() => portal.mutate("payment_method_update")}
                >
                  {portal.isPending ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <ExternalLink aria-hidden="true" />
                  )}
                  Update in Stripe
                </Button>
              ) : null}
              {portal.error ? <span>{getErrorMessage(portal.error, "Could not open Stripe.")}</span> : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={start.isPending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        {failure?.kind === "conflict" ? null : (
          <Button size="sm" disabled={start.isPending} onClick={confirm}>
            {start.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Start Pro now
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

/** Start Pro now from the trial's plan card. */
export function StartProNowDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="shadow-none">
        {open ? <StartProNowContent accountId={accountId} onCancel={() => onOpenChange(false)} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}
