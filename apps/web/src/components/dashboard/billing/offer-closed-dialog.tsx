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
import { formatUsd, intervalLabel, priceOfKey } from "~/lib/dashboard/billing-model"


/**
 * The founder offer filled up while the person looked at it. Doxa never
 * charges a price the person did not see, so Checkout opens only after they
 * accept the new price.
 */
export function OfferClosedDialog({
  priceKey,
  isPending,
  onCancel,
  onAccept,
}: {
  priceKey: string | null
  isPending: boolean
  onCancel: () => void
  onAccept: (priceKey: string) => void
}) {
  const price = priceKey ? priceOfKey(priceKey) : null
  const priceLine = price
    ? price.interval === "year"
      ? `${formatUsd(Math.round(price.amountCents / 12))} / month, billed yearly at ${formatUsd(price.amountCents)}`
      : `${formatUsd(price.amountCents)} / month, billed monthly`
    : null
  return (
    <Dialog open={priceKey !== null} onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <DialogContent className="shadow-none">
        <DialogHeader>
          <DialogTitle>The founder offer is full</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            The last founder spot was taken a moment ago.{" "}
            {priceLine ? `Pro ${price ? intervalLabel(price.interval).toLowerCase() : ""} is now ${priceLine}.` : null}{" "}
            Continue to Checkout at this price?
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={isPending || !priceKey} onClick={() => priceKey && onAccept(priceKey)}>
            Continue at the new price
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
