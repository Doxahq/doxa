import { AlertCircle, Loader2 } from "lucide-react"

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
} from "~/components/ui/dialog"

type GenerationActionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  isPending: boolean
  error: string | null
  onConfirm: () => Promise<boolean>
} & (
  | { action: "promote"; environmentLabel: string }
  | { action: "delete" }
)

export function GenerationActionDialog(
  props: GenerationActionDialogProps,
) {
  const isPromote = props.action === "promote"
  const title = isPromote
    ? "Promote"
    : "Delete generation"
  const description = isPromote
    ? "This generation becomes the live production documentation. The current production version stops serving. This action takes effect immediately."
    : "This removes the generation and its build log. Published documentation keeps serving. You cannot undo this."
  const confirmLabel = isPromote ? "Promote" : "Delete"

  function handleOpenChange(open: boolean): void {
    if (!open && props.isPending) return
    props.onOpenChange(open)
  }

  async function confirmAction(): Promise<void> {
    if (props.isPending) return
    if (await props.onConfirm()) props.onOpenChange(false)
  }

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="overscroll-contain shadow-none"
        onEscapeKeyDown={(event) => {
          if (props.isPending) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (props.isPending) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-balance">{title}</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <DialogDescription className="text-pretty">
            {description}
          </DialogDescription>

          {props.error ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>Could not {isPromote ? "promote" : "delete"} generation</AlertTitle>
              <AlertDescription className="break-words">
                {props.error}
              </AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.isPending}
              className="touch-manipulation"
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={isPromote ? "default" : "destructive"}
            size="sm"
            disabled={props.isPending}
            onClick={() => void confirmAction()}
            className="touch-manipulation"
          >
            {props.isPending ? (
              <Loader2
                aria-hidden="true"
                className="animate-spin"
              />
            ) : null}
            {props.isPending ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
