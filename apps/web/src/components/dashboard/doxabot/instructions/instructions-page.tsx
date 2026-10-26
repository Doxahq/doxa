import { Link } from "@tanstack/react-router"
import { ArrowLeft, Loader2 } from "lucide-react"

import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { PageBackNavigation } from "~/components/dashboard/page-back-navigation"
import {
  DoxabotInstructionsSkeleton,
  INSTRUCTIONS_PAGE_DESCRIPTION,
} from "~/components/dashboard/skeletons/doxabot-skeletons"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { ROLE_RESTRICTED_MESSAGE, useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useDoxabotInstructions } from "~/lib/dashboard/use-doxabot-instructions"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"

import { CodeLanguagesSection } from "./code-languages-section"
import { PagesSection } from "./pages-section"
import { ProjectContextSection } from "./project-context-section"
import { ReadersVoiceSection } from "./readers-voice-section"
import {
  InstructionsHistoryCard,
  InstructionsLimitsCard,
  PromptPreviewCard,
  RepositoryFileCard,
} from "./side-cards"
import { TerminologySection } from "./terminology-section"
import { UnsavedChangesGuard } from "./unsaved-changes-guard"
import { WritingRulesSection } from "./writing-rules-section"

/** Doxabot → Instructions: the editor for the project's Doxabot instructions. */
export function DoxabotInstructionsPage({ projectId }: { projectId: string }) {
  const editor = useDoxabotInstructions(projectId)
  const canConfigure = useProjectCapabilities(projectId).can("instructions.configure")
  const disabled = !canConfigure || editor.isSaving || editor.isRestoring

  const isFirstLoad = useIsFirstLoad([{ isPending: editor.isLoading }])
  if (isFirstLoad) return <DoxabotInstructionsSkeleton />

  const current = editor.state?.current ?? null
  const sectionProps = { instructions: editor.instructions, update: editor.update, disabled }

  return (
    <PageBody className="max-w-6xl">
      <PageBackNavigation>
        <Link to="/dashboard/projects/$projectId/doxabot" params={{ projectId }}>
          <ArrowLeft aria-hidden="true" />
          Doxabot
        </Link>
      </PageBackNavigation>
      <PageHeading
        label="Doxabot"
        title="Instructions"
        description={INSTRUCTIONS_PAGE_DESCRIPTION}
        actions={current ? (
          <span className="font-mono text-[11px] text-muted-foreground uppercase">
            Version {current.version} · used by the next generation
          </span>
        ) : undefined}
      />

      {editor.loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{editor.loadError}</AlertDescription>
        </Alert>
      ) : null}
      {canConfigure ? null : (
        <Alert>
          <AlertDescription>{ROLE_RESTRICTED_MESSAGE} Only a project owner or admin can change the instructions.</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <ReadersVoiceSection {...sectionProps} />
          <CodeLanguagesSection {...sectionProps} />
          <TerminologySection {...sectionProps} />
          <PagesSection {...sectionProps} />
          <WritingRulesSection {...sectionProps} screening={editor.screening} />
          <ProjectContextSection {...sectionProps} screening={editor.screening} />

          {canConfigure ? (
            <SaveBar
              isDirty={editor.isDirty}
              isSaving={editor.isSaving}
              nextVersion={(current?.version ?? 0) + 1}
              validationMessage={editor.validationMessage}
              writeError={editor.writeError}
              onSave={editor.save}
              onDiscard={editor.discard}
              onReload={editor.reload}
            />
          ) : null}
        </div>

        <aside className="flex w-full flex-col gap-4 lg:w-80 lg:shrink-0">
          <RepositoryFileCard {...sectionProps} />
          <PromptPreviewCard lines={editor.previewLines} />
          <InstructionsLimitsCard />
          <InstructionsHistoryCard
            history={editor.state?.history ?? []}
            currentVersion={current?.version ?? null}
            canRestore={canConfigure && !editor.isDirty}
            isRestoring={editor.isRestoring}
            onRestore={editor.restore}
          />
        </aside>
      </div>

      <UnsavedChangesGuard isDirty={editor.isDirty} />
    </PageBody>
  )
}

function SaveBar({
  isDirty,
  isSaving,
  nextVersion,
  validationMessage,
  writeError,
  onSave,
  onDiscard,
  onReload,
}: {
  isDirty: boolean
  isSaving: boolean
  nextVersion: number
  validationMessage: string | null
  writeError: { message: string; stale: boolean } | null
  onSave: () => void
  onDiscard: () => void
  onReload: () => void
}) {
  const note = !isDirty
    ? "No unsaved changes."
    : validationMessage ?? `Saving creates version ${nextVersion}. The next generation rewrites pages with it.`

  return (
    <div className="surface-card flex flex-col gap-2 px-5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">{note}</p>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={!isDirty || isSaving} onClick={onDiscard}>
            Discard
          </Button>
          <Button disabled={!isDirty || isSaving || validationMessage !== null} onClick={onSave}>
            {isSaving ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Save instructions
          </Button>
        </div>
      </div>
      {writeError ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-destructive">
          {writeError.message}
          {writeError.stale ? (
            <Button variant="outline" size="sm" onClick={onReload}>
              Reload
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
