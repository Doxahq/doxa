import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react"

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

/** The answer that is in progress, so its button shows the spinner. */
export type InstructionsOfferChoice = "instructions" | "generation"

interface InstructionsOfferContentProps {
  /** True when the offer is a step in another dialog, so leaving it goes back. */
  isStep?: boolean
  pendingChoice?: InstructionsOfferChoice | null
  error?: string | null
  onCancel: () => void
  onAddInstructions: () => void
  onGenerateWithout: () => void
}

/** The offer itself, for a dialog of its own or as a step in another dialog. */
export function InstructionsOfferContent({
  isStep = false,
  pendingChoice = null,
  error = null,
  onCancel,
  onAddInstructions,
  onGenerateWithout,
}: InstructionsOfferContentProps) {
  const isPending = pendingChoice !== null

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-balance">Do you want to provide instructions?</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <DialogDescription className="text-pretty">
          Instructions tell Doxabot how to write your docs: the tone, the rules, and the pages you want, such as guides,
          concepts, or API reference.
        </DialogDescription>
        <p className="text-sm text-body text-pretty">
          We recommend that you add them before the first generation. You can change them at any time.
        </p>
        {error ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertCircle aria-hidden="true" />
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" className="sm:mr-auto" disabled={isPending} onClick={onCancel}>
          {isStep ? <ArrowLeft aria-hidden="true" /> : null}
          {isStep ? "Back" : "Cancel"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={onGenerateWithout}>
          {pendingChoice === "generation" ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Generate without instructions
        </Button>
        <Button type="button" size="sm" disabled={isPending} onClick={onAddInstructions}>
          {pendingChoice === "instructions" ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Add instructions
        </Button>
      </DialogFooter>
    </>
  )
}

export interface InstructionsOfferDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddInstructions: () => void
  onGenerateWithout: () => void
}

export function InstructionsOfferDialog({
  open,
  onOpenChange,
  onAddInstructions,
  onGenerateWithout,
}: InstructionsOfferDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overscroll-contain shadow-none">
        <InstructionsOfferContent
          onCancel={() => onOpenChange(false)}
          onAddInstructions={onAddInstructions}
          onGenerateWithout={onGenerateWithout}
        />
      </DialogContent>
    </Dialog>
  )
}
