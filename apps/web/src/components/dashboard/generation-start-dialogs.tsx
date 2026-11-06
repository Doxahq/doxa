import type { ComponentProps } from "react"

import { GenerationStartConfirmationDialog } from "~/components/dashboard/generation-start-confirmation-dialog"
import {
  InstructionsOfferDialog,
  type InstructionsOfferDialogProps,
} from "~/components/dashboard/instructions-offer-dialog"

/** Every question that a start can ask. Takes `dialogProps` from `useGenerationStartFlow`. */
export function GenerationStartDialogs({
  confirmation,
  instructionsOffer,
}: {
  confirmation: ComponentProps<typeof GenerationStartConfirmationDialog>
  instructionsOffer: InstructionsOfferDialogProps
}) {
  return (
    <>
      <InstructionsOfferDialog {...instructionsOffer} />
      <GenerationStartConfirmationDialog {...confirmation} />
    </>
  )
}
