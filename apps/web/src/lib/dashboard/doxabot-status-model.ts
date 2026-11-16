import type { DoxabotSettingsDto, GenerationJobDto, ProjectDto } from "@doxahq/contracts"
import type { DoxabotInstructionsVersion } from "@doxahq/contracts/doxabot-instructions"

import { formatRelativeAge } from "~/lib/dashboard/relative-time"

/** One cell of the Doxabot status row. */
export interface DoxabotStatusFact {
  label: string
  value: string
  detail: string
  /** The date behind a relative `detail`. The row shows it exactly on hover. */
  detailDate?: string
  /** A colored dot before the value, for the state of the last generation. */
  tone?: "success" | "warning" | "destructive" | "muted"
  /** Code-like values (a repository name) use the mono face. */
  mono?: boolean
}

export interface DoxabotStatusInput {
  project: Pick<ProjectDto, "repositoryFullName"> | null
  latestJob: Pick<GenerationJobDto, "status" | "updatedAt"> | null
  instructions: Pick<DoxabotInstructionsVersion, "version" | "createdAt"> | null
  doxabot: DoxabotSettingsDto | null
  now?: number
}

const JOB_STATUS: Record<GenerationJobDto["status"], { value: string; tone: DoxabotStatusFact["tone"] }> = {
  queued: { value: "Queued", tone: "muted" },
  running: { value: "Running", tone: "muted" },
  succeeded: { value: "Completed", tone: "success" },
  failed: { value: "Failed", tone: "destructive" },
  cancelled: { value: "Cancelled", tone: "warning" },
  stopped_credits: { value: "Stopped: out of credits", tone: "warning" },
}

/** The four facts at the top of the Doxabot page: repository, last generation, instructions, previews. */
export function getDoxabotStatusFacts(input: DoxabotStatusInput): DoxabotStatusFact[] {
  return [repositoryFact(input), lastGenerationFact(input), instructionsFact(input), previewsFact(input)]
}

function repositoryFact({ project }: DoxabotStatusInput): DoxabotStatusFact {
  const fullName = project?.repositoryFullName
  return fullName
    ? { label: "Repository", value: fullName, detail: "Connected through GitHub", mono: true }
    : { label: "Repository", value: "Not connected", detail: "Connect one to generate docs" }
}

function lastGenerationFact({ latestJob, now }: DoxabotStatusInput): DoxabotStatusFact {
  if (!latestJob) return { label: "Last generation", value: "None yet", detail: "Run the first generation" }
  const status = JOB_STATUS[latestJob.status]
  return {
    label: "Last generation",
    value: status.value,
    detail: formatRelativeAge(latestJob.updatedAt, now),
    detailDate: latestJob.updatedAt,
    tone: status.tone,
  }
}

function instructionsFact({ instructions, now }: DoxabotStatusInput): DoxabotStatusFact {
  return instructions
    ? {
        label: "Instructions",
        value: `Version ${instructions.version}`,
        detail: `Edited ${formatRelativeAge(instructions.createdAt, now)}`,
        detailDate: instructions.createdAt,
      }
    : { label: "Instructions", value: "Not set", detail: "Default writing style" }
}

function previewsFact({ doxabot }: DoxabotStatusInput): DoxabotStatusFact {
  if (!doxabot) return { label: "PR previews", value: "—", detail: "Loading" }
  if (!doxabot.available) return { label: "PR previews", value: "Unavailable", detail: "See pull request previews below" }
  return doxabot.enabled
    ? { label: "PR previews", value: "On", detail: "Runs on pull requests" }
    : { label: "PR previews", value: "Off", detail: "Pull requests get no preview" }
}
