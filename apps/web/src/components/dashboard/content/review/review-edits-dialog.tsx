import { useState } from "react"

import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import type { EditsAtRisk } from "~/lib/dashboard/use-review-decisions"

interface EditsAtRiskCopy {
  title: string
  description: string
  confirm: string
}

/**
 * Only a new page and a removed page can leave the branch, so only they can
 * take edits with them. A group decision names the pages together.
 */
const EDITS_AT_RISK_COPY: Record<"added" | "removed", Record<"one" | "many", EditsAtRiskCopy>> = {
  removed: {
    one: {
      title: "Delete this page and your edits?",
      description: "You edited this page. Deleting it also removes your edits.",
      confirm: "Delete page",
    },
    many: {
      title: "Delete these pages and your edits?",
      description: "You edited some of these pages. Deleting them also removes your edits.",
      confirm: "Delete pages",
    },
  },
  added: {
    one: {
      title: "Discard this page and your edits?",
      description: "You edited this page. Discarding it also removes your edits.",
      confirm: "Discard page",
    },
    many: {
      title: "Discard these pages and your edits?",
      description: "You edited some of these pages. Discarding them also removes your edits.",
      confirm: "Discard pages",
    },
  },
}

function editsAtRiskCopy({ entries }: EditsAtRisk): EditsAtRiskCopy | null {
  const [first] = entries
  if (!first) return null
  return EDITS_AT_RISK_COPY[first.page.change === "added" ? "added" : "removed"][entries.length === 1 ? "one" : "many"]
}

/**
 * Asks before a decision removes a page that the person edited on the
 * review branch. Cancel leaves the page and its edits as they are.
 */
export function ReviewEditsDialog(props: {
  pending: EditsAtRisk | null
  onConfirm: () => void
  onCancel: () => void
}) {
  // The dialog keeps its words while it closes.
  const [shown, setShown] = useState(props.pending)
  if (props.pending && props.pending !== shown) setShown(props.pending)
  const copy = shown ? editsAtRiskCopy(shown) : null

  return (
    <Dialog open={props.pending !== null} onOpenChange={(open) => (open ? undefined : props.onCancel())}>
      <DialogContent className="shadow-none">
        <DialogHeader>
          <DialogTitle>{copy?.title}</DialogTitle>
          <DialogDescription className="text-pretty">{copy?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={props.onConfirm}>
            {copy?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
