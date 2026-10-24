import { useState } from "react"
import { AlertCircle, Loader2, Trash2 } from "lucide-react"

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

interface DocsDomainDeleteDialogProps {
  hostname: string
  disabled: boolean
  isDeleting: boolean
  onDelete: () => Promise<string | null>
}

export function DocsDomainDeleteDialog({
  hostname,
  disabled,
  isDeleting,
  onDelete,
}: DocsDomainDeleteDialogProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && isDeleting) return
    if (nextOpen) setError(null)
    setOpen(nextOpen)
  }

  async function confirmDelete(): Promise<void> {
    if (isDeleting) return

    setError(null)
    const next = getDeleteDialogState(await onDelete())
    setError(next.error)
    setOpen(next.open)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
        >
          <Trash2 aria-hidden="true" />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent
        className="shadow-none"
        onEscapeKeyDown={(event) => {
          if (isDeleting) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (isDeleting) event.preventDefault()
        }}
      >
        <DocsDomainDeleteContent
          hostname={hostname}
          error={error}
          isDeleting={isDeleting}
          onDelete={() => void confirmDelete()}
        />
      </DialogContent>
    </Dialog>
  )
}

export function getDeleteDialogState(error: string | null): {
  open: boolean
  error: string | null
} {
  return { open: error !== null, error }
}

export function DocsDomainDeleteContent({
  hostname,
  error,
  isDeleting,
  onDelete,
}: {
  hostname: string
  error: string | null
  isDeleting: boolean
  onDelete: () => void
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-balance">Delete domain?</DialogTitle>
        <DialogDescription className="break-all text-pretty">
          {hostname}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          This permanently removes the custom hostname from Doxa and Cloudflare. Your documentation remains available on its Doxa domain. You can connect this hostname to another project.
        </p>
        <p className="text-sm leading-6 text-foreground">
          Doxa does not remove the CNAME from your DNS provider.
        </p>

        {error ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Could not delete domain</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm" disabled={isDeleting}>
            Keep domain
          </Button>
        </DialogClose>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={isDeleting}
          onClick={onDelete}
        >
          {isDeleting ? (
            <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <Trash2 aria-hidden="true" />
          )}
          {isDeleting ? "Deleting…" : "Delete domain"}
        </Button>
      </DialogFooter>
    </>
  )
}
