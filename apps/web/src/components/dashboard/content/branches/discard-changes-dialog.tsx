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
import { useDialogFocusReturn } from "~/lib/dashboard/use-dialog-focus-return"

export function DiscardChangesDialog(props: {
  branchName: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  isDiscarding: boolean
  onDiscard: () => Promise<void>
}) {
  const focusReturn = useDialogFocusReturn()
  const target = props.branchName
    ? `branch ${props.branchName}`
    : "your unpublished main changes"

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent {...focusReturn}>
        <DialogHeader>
          <DialogTitle>Discard all changes?</DialogTitle>
          <DialogDescription>
            This permanently removes every unpublished change from {target}.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            The live documentation does not change.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Keep changes
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void props.onDiscard()}
            disabled={props.isDiscarding}
          >
            {props.isDiscarding ? "Discarding…" : "Discard all changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
