import { Loader2, Play } from "lucide-react"

import { GenerationStartConfirmationDialog } from "~/components/dashboard/generation-start-confirmation-dialog"
import { Button } from "~/components/ui/button"
import { PRO_REASON_GENERATION } from "~/lib/dashboard/ai-access"
import { useProGate } from "~/lib/dashboard/pro-trial-dialog"
import { useProjectAiAccess } from "~/lib/dashboard/use-ai-access"
import { useDoxabotInstructions } from "~/lib/dashboard/use-doxabot-instructions"
import { useGenerationStarter } from "~/lib/dashboard/use-generation-starter"
import { useProjectGenerations } from "~/lib/dashboard/use-project-generations"

import { InstructionsBarFrame } from "./instructions-bar-frame"

/** What a click does now. Exported for tests. */
export function saveAndStartNote(input: {
  isDirty: boolean
  validationMessage: string | null
  savedVersion: number | null
}): string {
  if (input.isDirty) {
    if (input.validationMessage) return input.validationMessage
    return `Saving creates version ${(input.savedVersion ?? 0) + 1}. The generation then starts with it.`
  }
  return input.savedVersion === null
    ? "No instructions yet. Add them above, or start without them."
    : `The generation starts with version ${input.savedVersion}.`
}

/**
 * The instructions bar when the page is a step before a generation. The person
 * already answered the instructions offer, so the start does not ask again.
 * For an account without the Doxa Agent (Free), the click opens the Pro trial
 * dialog before it saves anything.
 */
export function SaveAndStartBar({
  projectId,
  editor,
}: {
  projectId: string
  editor: ReturnType<typeof useDoxabotInstructions>
}) {
  const generations = useProjectGenerations(projectId)
  const { startGeneration, confirmationDialogProps } = useGenerationStarter(projectId, generations)
  const isBusy = editor.isSaving || generations.isStarting
  const proGate = useProGate(useProjectAiAccess(projectId))

  async function saveAndStart(): Promise<void> {
    if (proGate(PRO_REASON_GENERATION)) return
    if (editor.isDirty && !(await editor.save())) return
    await startGeneration()
  }

  return (
    <>
      <InstructionsBarFrame
        note={saveAndStartNote({
          isDirty: editor.isDirty,
          validationMessage: editor.validationMessage,
          savedVersion: editor.state?.current?.version ?? null,
        })}
        writeError={editor.writeError}
        startError={generations.startError}
        onReload={editor.reload}
        actions={(
          <>
            <Button variant="ghost" disabled={!editor.isDirty || isBusy} onClick={editor.discard}>
              Discard
            </Button>
            <Button
              disabled={
                isBusy
                || generations.hasActiveGeneration
                || (editor.isDirty && editor.validationMessage !== null)
              }
              onClick={() => void saveAndStart()}
            >
              {isBusy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
              {editor.isDirty ? "Save and start generation" : "Start generation"}
            </Button>
          </>
        )}
      />
      <GenerationStartConfirmationDialog {...confirmationDialogProps} />
    </>
  )
}
