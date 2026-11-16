import {
  GENERATION_RESUMED_EVENT_TYPE,
  type GenerationActionBlockedReason,
  type GenerationDetailDto,
  type GenerationDomainDto,
  type GenerationJobDto,
  type GenerationRerunLinksDto,
  type GenerationStartResultDto,
  type GenerationsPageDto,
  type JobEventDto,
} from "@doxahq/contracts"

import { isTerminalJob } from "~/lib/dashboard/model"

export function canCancelGeneration(job: GenerationJobDto): boolean {
  return job.status === "queued" || job.status === "running"
}

export function requiresGenerationConfirmation(
  result: GenerationStartResultDto,
): result is Extract<
  GenerationStartResultDto,
  { outcome: "confirmation_required" }
> {
  return result.outcome === "confirmation_required"
}

export function dedupeGenerations(pages: GenerationsPageDto[]): GenerationJobDto[] {
  const seen = new Set<string>()
  const generations: GenerationJobDto[] = []

  for (const page of pages) {
    for (const generation of page.generations) {
      if (seen.has(generation.id)) continue
      seen.add(generation.id)
      generations.push(generation)
    }
  }

  return generations
}

/**
 * The time a generation worked: from its creation to its end (or now),
 * without each wait before a continue. A run stopped for credits can wait
 * for hours before the user continues it. With the job's events, a wait is
 * the time from the event before a `generation_resumed` event to that
 * event. Without them (the generations list), it is the job's `pausedMs`.
 */
export function getGenerationDurationMs(
  job: GenerationJobDto,
  nowMs = Date.now(),
  events: readonly Pick<JobEventDto, "type" | "createdAt">[] = [],
): number {
  const startedAt = new Date(job.createdAt).getTime()
  const endedAt = isTerminalJob(job) ? new Date(job.updatedAt).getTime() : nowMs
  const waitMs = events.length > 0 ? resumeWaitMs(events) : (job.pausedMs ?? 0)
  return Math.max(0, endedAt - startedAt - waitMs)
}

function resumeWaitMs(events: readonly Pick<JobEventDto, "type" | "createdAt">[]): number {
  let waitMs = 0
  events.forEach((event, index) => {
    const previous = events[index - 1]
    if (event.type !== GENERATION_RESUMED_EVENT_TYPE || !previous) return
    waitMs += Math.max(0, new Date(event.createdAt).getTime() - new Date(previous.createdAt).getTime())
  })
  return waitMs
}

export function formatGenerationDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

export function getDeploymentLabel(
  status: GenerationJobDto["status"],
): "Successful" | "Failed" | "Stopped" | "In progress" {
  if (status === "succeeded") return "Successful"
  if (status === "stopped_credits") return "Stopped"
  if (status === "failed" || status === "cancelled") return "Failed"
  return "In progress"
}

export function shortenGenerationId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

const NO_RERUN_LINKS: GenerationRerunLinksDto = { rerunOfId: null, rerunId: null }

/**
 * The re-run links of a run. An API from before the links sends none, and
 * the web can meet one while a deploy rolls out.
 */
export function getRerunLinks(
  generation: GenerationDetailDto,
): GenerationRerunLinksDto {
  const links: GenerationRerunLinksDto | undefined = generation.rerunLinks
  return links ?? NO_RERUN_LINKS
}

/**
 * True when the run is a pull request preview that wrote a version, so its
 * changes can be read. A production run shows its changes in its review.
 */
export function hasReadableChanges(generation: {
  status: GenerationDetailDto["status"]
  deployment: Pick<GenerationDetailDto["deployment"], "environment" | "docsVersionId">
}): boolean {
  return (
    generation.deployment.environment === "preview" &&
    generation.status === "succeeded" &&
    generation.deployment.docsVersionId !== null
  )
}

export function getGenerationTitle(
  generation: GenerationDetailDto,
): string {
  return `Generation ${shortenGenerationId(generation.id)}`
}

export function getDomainRoleLabel(
  role: GenerationDomainDto["role"],
): string {
  const labels = {
    production: "Production",
    generated: "Generated",
    preview: "Preview",
    permanent: "Permanent",
  } satisfies Record<GenerationDomainDto["role"], string>
  return labels[role]
}

export function getActionBlockedMessage(
  reason: GenerationActionBlockedReason,
): string {
  const messages = {
    not_succeeded: "This generation did not succeed.",
    no_docs_version:
      "This generation published no documentation version.",
    already_production:
      "This generation is already live in production.",
    in_progress: "Cancel the generation before you delete it.",
    serving_production: "This generation is live in production.",
    serving_preview:
      "This generation is the current preview for its pull request.",
    review_required:
      "This generation waits in a review. Publish it from the review.",
    not_finished: "A generation runs again only after it ends.",
    superseded: "A newer run for this pull request replaced this generation.",
    change_not_open: "The pull request is closed, merged, or a draft.",
    base_not_production: "The pull request does not target the production branch.",
    previews_unavailable: "Pull request previews are not available for this project.",
    promote_expired:
      "A newer push replaced this preview too long ago to promote it.",
    version_collected:
      "The files of this generation were deleted after the retention period.",
    not_resumable:
      "This generation cannot continue from where it stopped. Re-run it instead.",
  } satisfies Record<GenerationActionBlockedReason, string>
  return messages[reason]
}
