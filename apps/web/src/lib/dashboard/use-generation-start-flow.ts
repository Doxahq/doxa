import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"

import { loadInstructionsOffer } from "~/lib/dashboard/instructions-offer"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useGenerationStarter, type GenerationStartAction } from "~/lib/dashboard/use-generation-starter"

/**
 * Starts a new generation from a project page. Before the project's first
 * generation it offers the instructions page, then starts as usual. Exposes
 * the props for `GenerationStartDialogs`.
 */
export function useGenerationStartFlow(
  projectId: string,
  generations: GenerationStartAction,
  options: { skipInstructionsOffer?: boolean } = {},
) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const canConfigureInstructions = useProjectCapabilities(projectId).can("instructions.configure")
  const { startGeneration, confirmationDialogProps } = useGenerationStarter(projectId, generations)
  const [isOfferOpen, setIsOfferOpen] = useState(false)

  async function requestGeneration(): Promise<void> {
    if (!options.skipInstructionsOffer && (await loadInstructionsOffer(queryClient, projectId, canConfigureInstructions))) {
      setIsOfferOpen(true)
      return
    }
    await startGeneration()
  }

  return {
    startGeneration: requestGeneration,
    dialogProps: {
      confirmation: confirmationDialogProps,
      instructionsOffer: {
        open: isOfferOpen,
        onOpenChange: setIsOfferOpen,
        onAddInstructions: () => {
          setIsOfferOpen(false)
          void navigate({
            to: "/dashboard/projects/$projectId/doxabot/instructions",
            params: { projectId },
            search: { then: "generate" },
          })
        },
        onGenerateWithout: () => {
          setIsOfferOpen(false)
          void startGeneration()
        },
      },
    },
  }
}
