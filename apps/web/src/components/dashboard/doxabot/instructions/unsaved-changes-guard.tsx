import { useBlocker } from "@tanstack/react-router"

import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"

/** Asks before a navigation drops unsaved instructions. Closing the tab asks through the browser. */
export function UnsavedChangesGuard({ isDirty }: { isDirty: boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: () => isDirty,
    withResolver: true,
  })
  const isOpen = blocker.status === "blocked"

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open && isOpen ? blocker.reset() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leave without saving?</DialogTitle>
          <DialogDescription>Your changes to the instructions are not saved yet.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => (isOpen ? blocker.reset() : undefined)}>
            Stay
          </Button>
          <Button onClick={() => (isOpen ? blocker.proceed() : undefined)}>Leave</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
