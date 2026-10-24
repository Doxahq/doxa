import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import type { GenerationConfirmationReason } from "@doxahq/contracts"
import { toast } from "sonner"

import type { GenerationStartResultDto } from "@doxahq/contracts"
import { requiresGenerationConfirmation } from "~/lib/dashboard/generation-model"
import type { GenerationStartOptions } from "~/lib/platform-api"

/** Something that starts a generation: a new run, or a failed run again. */
export interface GenerationStartAction {
  /** Null when the request failed; the error is in `startError`. */
  start: (options: GenerationStartOptions) => Promise<GenerationStartResultDto | null>
  isStarting: boolean
  startError: string | null
}

/**
 * Starts a generation and opens its detail page. When the server asks for
 * confirmation (no source changes, or pages written in the editor), exposes
 * props for `GenerationStartConfirmationDialog`.
 */
export function useGenerationStarter(
  projectId: string,
  generations: GenerationStartAction,
) {
  const navigate = useNavigate()
  const [confirmation, setConfirmation] = useState<{
    reason: GenerationConfirmationReason
    message: string
  } | null>(null)

  async function startGeneration(options: GenerationStartOptions = {}) {
    const result = await generations.start(options)
    if (!result) return
    if (requiresGenerationConfirmation(result)) {
      setConfirmation({ reason: result.reason, message: result.message })
      return
    }
    if (result.outcome === "already_active" && result.message) {
      toast.info(result.message)
    }
    await navigate({
      to: "/dashboard/projects/$projectId/generations/$generationId",
      params: { projectId, generationId: result.job.id },
    })
  }

  function setConfirmationOpen(open: boolean): void {
    if (!open && !generations.isStarting) setConfirmation(null)
  }

  return {
    startGeneration,
    confirmationDialogProps: {
      open: confirmation !== null,
      reason: confirmation?.reason ?? "unchanged_source",
      message: confirmation?.message ?? "",
      isPending: generations.isStarting,
      error: generations.startError,
      onOpenChange: setConfirmationOpen,
      onConfirm: (choice: { seed: boolean }) => void startGeneration({ force: true, seed: choice.seed }),
    },
  }
}
