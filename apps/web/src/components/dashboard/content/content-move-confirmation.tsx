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

export interface ContentMoveConfirmationValue {
  description: string
  onConfirm: () => Promise<void>
}

interface ContentMoveConfirmationProps {
  value: ContentMoveConfirmationValue | null
  onOpenChange: (open: boolean) => void
  pending: boolean
}

/** Warns before a move changes one or more public page URLs. */
export function ContentMoveConfirmation({
  value,
  onOpenChange,
  pending,
}: ContentMoveConfirmationProps) {
  return (
    <Dialog open={value !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move across sections?</DialogTitle>
          <DialogDescription>
            This changes public page URLs. You can move the item back before publishing.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="font-mono text-xs leading-5 text-foreground">{value?.description}</p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => void value?.onConfirm().catch(() => undefined)}
          >
            {pending ? "Moving…" : "Move item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
