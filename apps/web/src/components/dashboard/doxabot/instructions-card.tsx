import { Link } from "@tanstack/react-router"
import { ChevronRight, FileText } from "lucide-react"
import {
  DOXABOT_REPOSITORY_INSTRUCTIONS_PATH,
  type DoxabotInstructions,
  type DoxabotInstructionsVersion,
} from "@doxahq/contracts/doxabot-instructions"
import { DOXABOT_CODE_LANGUAGE_LABELS } from "@doxahq/contracts/doxabot-instruction-prompt"

import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import {
  ADDRESS_OPTIONS,
  LEVEL_OPTIONS,
  READER_OPTIONS,
  TONE_OPTIONS,
  type Option,
} from "~/lib/dashboard/doxabot-instructions-model"
import { formatInstructionsAuthor } from "~/lib/dashboard/doxabot-instructions-format"

/** Doxabot → Instructions: a summary of the saved instructions and the way to the editor. */
export function InstructionsCard({
  projectId,
  current,
}: {
  projectId: string
  current: DoxabotInstructionsVersion | null
}) {
  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <FileText aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3>Instructions</h3>
            </CardTitle>
            <CardDescription>
              Tell Doxabot who reads your docs, how they should sound and what it cannot learn from the code.
              Changes apply to the next generation.
            </CardDescription>
          </div>
        </div>
        <Button variant="outline" className="w-fit shrink-0" asChild>
          <Link to="/dashboard/projects/$projectId/doxabot/instructions" params={{ projectId }}>
            {current ? "Manage" : "Set up"}
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 border-t border-border pt-5">
        {current ? (
          <>
            <ul aria-label="Current instructions" className="flex flex-wrap gap-2">
              {summaryChips(current.instructions).map((chip) => (
                <li
                  key={chip.label}
                  className="inline-flex items-center gap-1.5 border border-border bg-background px-2.5 py-1 text-xs text-foreground"
                >
                  <span className="font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
                    {chip.label}
                  </span>
                  {chip.value}
                </li>
              ))}
            </ul>
            <p className="font-mono text-xs text-muted-foreground uppercase">
              Version {current.version} · {formatInstructionsAuthor(current)}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Not set yet. Doxabot writes with its default style.</p>
        )}
      </CardContent>
    </Card>
  )
}

interface SummaryChip {
  label: string
  value: string
}

function summaryChips(instructions: DoxabotInstructions): SummaryChip[] {
  const chips: SummaryChip[] = [
    {
      label: "Readers",
      value: `${labelOf(READER_OPTIONS, instructions.audience.reader)} · ${labelOf(LEVEL_OPTIONS, instructions.audience.level)}`,
    },
    {
      label: "Tone",
      value: `${labelOf(TONE_OPTIONS, instructions.voice.tone)}, ${labelOf(ADDRESS_OPTIONS, instructions.voice.address)}`,
    },
  ]
  if (instructions.codeLanguages.length > 0) {
    chips.push({
      label: "Code",
      value: instructions.codeLanguages.map((language) => DOXABOT_CODE_LANGUAGE_LABELS[language]).join(", "),
    })
  }
  if (instructions.terminology.length > 0) chips.push({ label: "Terms", value: String(instructions.terminology.length) })
  if (instructions.rules.length > 0) chips.push({ label: "Writing rules", value: String(instructions.rules.length) })
  if (instructions.repositoryFile.enabled) chips.push({ label: "Repo file", value: DOXABOT_REPOSITORY_INSTRUCTIONS_PATH })
  return chips
}

function labelOf<T extends string>(options: readonly Option<T>[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? value
}
