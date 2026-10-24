import { Button } from "~/components/ui/button"
import { useDialogFocusReturn } from "~/lib/dashboard/use-dialog-focus-return"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"

export interface ContentDeleteConfirmationValue {
  /** What goes, for example `the group Introduction`. */
  target: string
  /** How many pages the delete removes. Zero for a single page. */
  pageCount: number
  onConfirm: () => Promise<void>
}

interface ContentDeleteConfirmationProps {
  value: ContentDeleteConfirmationValue | null
  onOpenChange: (open: boolean) => void
  pending: boolean
}

/**
 * Confirms a delete before it runs.
 *
 * A delete of a section or a group takes every page inside it, and the count
 * is the fact a reader needs before answering. The change stays unpublished,
 * so it is reversible until the next publish, and the dialog says so.
 */
export function ContentDeleteConfirmation({
  value,
  onOpenChange,
  pending,
}: ContentDeleteConfirmationProps) {
  const focusReturn = useDialogFocusReturn()
  /**
   * Runs the delete, then closes.
   *
   * A failure keeps the dialog open. The message appears in the editor, and the
   * reader can try again without opening the menu a second time.
   */
  const confirm = async () => {
    if (!value) return
    try {
      await value.onConfirm()
    } catch {
      return
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={value !== null} onOpenChange={onOpenChange}>
      <DialogContent {...focusReturn}>
        <DialogHeader>
          <DialogTitle>Delete {value?.target}?</DialogTitle>
          <DialogDescription>
            This change stays unpublished. Discard all changes to get it back.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-xs leading-5 text-foreground">
            {value && value.pageCount > 0
              ? `This removes ${value.pageCount} ${value.pageCount === 1 ? "page" : "pages"}.`
              : "This removes the page and its content."}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
