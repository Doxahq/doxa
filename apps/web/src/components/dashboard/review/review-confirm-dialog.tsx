import type { ReactNode } from "react"
import { AlertCircle, Loader2 } from "lucide-react"

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

/** A confirmation for one review action. It stays open while the action runs. */
export function ReviewConfirmDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children?: ReactNode
  confirmLabel: string
  pendingLabel: string
  destructive?: boolean
  isPending: boolean
  error: string | null
  onConfirm: () => void
}) {
  function handleOpenChange(open: boolean): void {
    if (!open && props.isPending) return
    props.onOpenChange(open)
  }

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent className="overscroll-contain shadow-none">
        <DialogHeader>
          <DialogTitle className="text-balance">{props.title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <DialogDescription className="text-pretty">{props.description}</DialogDescription>
          {props.children}
          {props.error ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertCircle aria-hidden="true" />
              <AlertDescription className="break-words">{props.error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={props.isPending} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant={props.destructive ? "destructive" : "default"}
            disabled={props.isPending}
            onClick={props.onConfirm}
          >
            {props.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {props.isPending ? props.pendingLabel : props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
