import { useEffect, useState } from "react"
import { AlertCircle, CircleStop, Loader2 } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog"

interface GenerationCancelDialogProps {
  canCancel: boolean
  isCancelling: boolean
  error: string | null
  onCancel: () => Promise<boolean>
  onReset: () => void
}

export function GenerationCancelDialog({
  canCancel,
  isCancelling,
  error,
  onCancel,
  onReset,
}: GenerationCancelDialogProps) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!canCancel) setOpen(false)
  }, [canCancel])

  if (!canCancel) return null

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && isCancelling) return
    if (nextOpen) onReset()
    setOpen(nextOpen)
  }

  async function confirmCancellation(): Promise<void> {
    if (isCancelling) return
    if (await onCancel()) setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="touch-manipulation"
        >
          <CircleStop aria-hidden="true" />
          Cancel generation
        </Button>
      </DialogTrigger>
      <DialogContent
        className="overscroll-contain shadow-none"
        onEscapeKeyDown={(event) => {
          if (isCancelling) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (isCancelling) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-balance">Cancel generation?</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <DialogDescription className="text-pretty">
            This stops the active generation. No generated documentation from this run will be published.
          </DialogDescription>

          {error ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>Could not cancel generation</AlertTitle>
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isCancelling}
              className="touch-manipulation"
            >
              Keep running
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={isCancelling}
            onClick={() => void confirmCancellation()}
            className="touch-manipulation"
          >
            {isCancelling ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : null}
            {isCancelling ? "Cancelling…" : "Cancel generation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
