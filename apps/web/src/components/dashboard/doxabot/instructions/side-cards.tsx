import type { ReactNode } from "react"
import { DOXABOT_REPOSITORY_INSTRUCTIONS_PATH } from "@doxahq/contracts/doxabot-instructions"
import type { DoxabotInstructionsVersionSummary } from "@doxahq/contracts/doxabot-instructions"

import { SwitchRow } from "~/components/dashboard/content/site-settings/fields/controls"
import { Button } from "~/components/ui/button"
import { formatInstructionsAuthor } from "~/lib/dashboard/doxabot-instructions-format"

import { fieldId, type InstructionsSectionProps } from "./section-props"

/** A small bordered card for the side column. */
function SideCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="surface-card flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-xs font-bold tracking-[0.14em] text-foreground uppercase">{title}</h2>
        {description ? <p className="text-[12.5px] leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function RepositoryFileCard({ instructions, update, disabled }: InstructionsSectionProps) {
  const enabled = instructions.repositoryFile.enabled
  return (
    <SideCard title="Instructions file">
      <SwitchRow
        id={fieldId("repository-file")}
        title={`Also read ${DOXABOT_REPOSITORY_INSTRUCTIONS_PATH}`}
        description="From your repository's default branch."
        checked={enabled}
        disabled={disabled}
        onCheckedChange={(checked) => update((current) => ({ ...current, repositoryFile: { enabled: checked } }))}
      />
      {enabled ? (
        <ul className="flex flex-col gap-1.5 border-t border-divider pt-3 text-[12.5px] leading-5 text-muted-foreground">
          <li>Pull request previews use the file from the default branch, not the copy in the pull request.</li>
          <li>If the file and this page disagree, this page wins.</li>
        </ul>
      ) : null}
    </SideCard>
  )
}

export function PromptPreviewCard({ lines }: { lines: readonly string[] }) {
  return (
    <SideCard
      title="What Doxabot reads"
      description="Doxa turns your choices into these lines. Your own words stay in quotes."
    >
      <pre className="max-h-[26rem] overflow-y-auto border border-divider bg-background p-3 font-mono text-[11.5px] leading-[18px] break-words whitespace-pre-wrap text-muted-foreground">
        {lines.join("\n")}
      </pre>
    </SideCard>
  )
}

export function InstructionsLimitsCard() {
  return (
    <SideCard title="Instructions cannot change">
      <ul className="flex list-disc flex-col gap-1 pl-4 text-[12.5px] leading-5 text-muted-foreground">
        <li>Which files and repositories Doxabot can read</li>
        <li>The tools Doxabot uses</li>
        <li>Page format and components</li>
        <li>Where and when docs are published</li>
      </ul>
    </SideCard>
  )
}

export function InstructionsHistoryCard({
  history,
  currentVersion,
  canRestore,
  isRestoring,
  onRestore,
}: {
  history: readonly DoxabotInstructionsVersionSummary[]
  currentVersion: number | null
  canRestore: boolean
  isRestoring: boolean
  onRestore: (version: number) => void
}) {
  return (
    <SideCard title="History">
      {history.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No saved versions yet.</p>
      ) : (
        <ol className="flex flex-col">
          {history.map((entry) => (
            <li
              key={entry.version}
              className="flex min-h-10 items-center justify-between gap-2 border-t border-divider py-1.5 first:border-t-0 text-[12.5px]"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-foreground">Version {entry.version}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{formatInstructionsAuthor(entry)}</span>
              </span>
              {entry.version === currentVersion ? (
                <span className="font-mono text-[10.5px] tracking-widest text-success uppercase">Current</span>
              ) : canRestore ? (
                <Button variant="ghost" size="sm" disabled={isRestoring} onClick={() => onRestore(entry.version)}>
                  Restore
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </SideCard>
  )
}
