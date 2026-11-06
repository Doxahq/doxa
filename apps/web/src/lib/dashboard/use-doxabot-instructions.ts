import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  DEFAULT_DOXABOT_INSTRUCTIONS,
  type DoxabotInstructions,
  type DoxabotInstructionsState,
} from "@doxahq/contracts/doxabot-instructions"
import { screenDoxabotInstructions } from "@doxahq/contracts/doxabot-instruction-screening"
import { renderDoxabotInstructionLines } from "@doxahq/contracts/doxabot-instruction-prompt"

import { ApiRequestError } from "~/lib/api-errors"
import { restoreDoxabotInstructions, saveDoxabotInstructions } from "~/lib/doxabot-instructions-api"
import {
  checkInstructions,
  sameInstructions,
  withoutBlankEntries,
} from "~/lib/dashboard/doxabot-instructions-model"
import { getErrorMessage } from "~/lib/errors"
import {
  doxabotInstructionsQueryKey,
  doxabotInstructionsQueryOptions,
} from "~/lib/queries/doxabot-instructions"

export type InstructionsUpdate = (current: DoxabotInstructions) => DoxabotInstructions

/**
 * Doxabot → Instructions: the saved state, the unsaved draft, and the save
 * and restore actions. The draft is screened and rendered as the user types,
 * with the same functions the API and the agent use.
 */
export function useDoxabotInstructions(projectId: string) {
  const queryClient = useQueryClient()
  const query = useQuery(doxabotInstructionsQueryOptions(projectId))
  const [draft, setDraft] = useState<DoxabotInstructions | null>(null)

  const saved = query.data?.current ?? null
  const base = saved?.instructions ?? DEFAULT_DOXABOT_INSTRUCTIONS
  const instructions = draft ?? base
  const baseVersion = saved?.version ?? null
  const isDirty = draft !== null && !sameInstructions(withoutBlankEntries(draft), base)

  const screening = useMemo(() => screenDoxabotInstructions(instructions), [instructions])
  const previewLines = useMemo(
    () => renderDoxabotInstructionLines({ instructions, screening }),
    [instructions, screening],
  )
  const check = checkInstructions(instructions)

  const acceptSaved = (state: DoxabotInstructionsState) => {
    queryClient.setQueryData(doxabotInstructionsQueryKey(projectId), state)
    setDraft(null)
  }

  const save = useMutation({
    mutationFn: (valid: DoxabotInstructions) =>
      saveDoxabotInstructions(projectId, { instructions: valid, baseVersion }),
    onSuccess: acceptSaved,
  })

  const restore = useMutation({
    mutationFn: (version: number) => restoreDoxabotInstructions(projectId, { version, baseVersion }),
    onSuccess: acceptSaved,
  })

  const writeError = save.error ?? restore.error

  return {
    state: query.data ?? null,
    isLoading: query.isPending,
    loadError: query.error ? getErrorMessage(query.error, "The instructions could not be loaded.") : null,
    instructions,
    update: (change: InstructionsUpdate) => setDraft(change(instructions)),
    discard: () => setDraft(null),
    isDirty,
    screening,
    previewLines,
    validationMessage: check.ok ? null : check.message,
    /** True when the draft was saved. The error is in `writeError`. */
    save: async (): Promise<boolean> => {
      if (!check.ok) return false
      try {
        await save.mutateAsync(check.instructions)
        return true
      } catch {
        return false
      }
    },
    isSaving: save.isPending,
    restore: (version: number) => restore.mutate(version),
    isRestoring: restore.isPending,
    writeError: writeError ? describeWriteError(writeError) : null,
    reload: () => {
      save.reset()
      restore.reset()
      setDraft(null)
      void query.refetch()
    },
  }
}

export interface InstructionsWriteError {
  message: string
  /** Someone saved newer instructions; reloading shows them. */
  stale: boolean
}

function describeWriteError(error: Error): InstructionsWriteError {
  const stale = error instanceof ApiRequestError && error.status === 409
  return {
    stale,
    message: stale
      ? "Someone saved newer instructions. Reload to see them before you save."
      : getErrorMessage(error, "The instructions could not be saved."),
  }
}
