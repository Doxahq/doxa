import type {
  DocsDomainDto,
  GenerationJobDto,
  JobEventDto,
  ProjectDto,
} from "@doxahq/contracts"

export type LoadState = "idle" | "loading" | "ready" | "error"
export type ProjectPublicationState = "published" | "not_generated"
export type VerificationRecord = {
  label: string
  value: string
}

/** Progress by the type of a generation log line. The API hides internal event types. */
export const EVENT_PROGRESS: Record<string, number> = {
  request_sent: 4,
  queued: 6,
  doxabot_queued: 6,
  running: 10,
  preview_workflow_started: 14,
  production_workflow_started: 14,
  project_instructions_applied: 16,
  snapshot_started: 20,
  clone_started: 20,
  snapshot_complete: 26,
  clone_complete: 26,
  analysis_started: 30,
  repo_map_ready: 34,
  analysis_progress: 40,
  api_reference_source: 50,
  analysis_complete: 55,
  plan_cache_hit: 60,
  structure_started: 60,
  structure_review_started: 66,
  structure_reused: 68,
  structure_patched: 70,
  structure_review_decided: 72,
  structure_reviewed: 72,
  structure_pages_removed_by_instructions: 74,
  structure_created: 76,
  writing_started: 80,
  page_write_completed: 84,
  page_write_failed: 84,
  page_written: 84,
  pages_written: 88,
  generation_page_notice: 88,
  artifact_link_warning: 92,
  staged_for_review: 100,
  preview_published: 100,
  published: 100,
  failed: 100,
  generation_cancelled: 100,
}

export function getJobProgress(job: GenerationJobDto, events: JobEventDto[]): number {
  if (isTerminalJob(job)) return 100

  const eventProgress = events.reduce((max, event) => Math.max(max, EVENT_PROGRESS[event.type] ?? 0), 0)
  const statusProgress = job.status === "running" ? 10 : job.status === "queued" ? 6 : 0
  return Math.max(eventProgress, statusProgress)
}

export function isTerminalJob(job: GenerationJobDto): boolean {
  return job.status !== "queued" && job.status !== "running"
}

export function createLocalStartedEvent(job: GenerationJobDto): JobEventDto {
  return {
    id: `${job.id}:local-started`,
    jobId: job.id,
    sequence: 1,
    source: "system",
    type: "request_sent",
    message: "Generation request accepted by the dashboard.",
    data: null,
    createdAt: new Date().toISOString(),
  }
}

export function isProjectPublished(project: Pick<ProjectDto, "publishedVersionId">): boolean {
  return Boolean(project.publishedVersionId)
}

export function getProjectPublicationState(
  project: Pick<ProjectDto, "publishedVersionId">,
): ProjectPublicationState {
  return isProjectPublished(project) ? "published" : "not_generated"
}

export function getProjectPublicationLabel(state: ProjectPublicationState): string {
  return state === "published" ? "published" : "not generated"
}

export function formatEventType(value: string): string {
  return value.replace(/_/g, " ")
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value))
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")} elapsed`
}

export function formatDataValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(formatDataValue).join(", ")
  if (value && typeof value === "object") return JSON.stringify(value)
  return String(value)
}

export function getDnsRecords(domain: DocsDomainDto): VerificationRecord[] {
  if (!domain.dnsRecord) return []

  return [
    { label: "Type", value: domain.dnsRecord.type },
    { label: "Name", value: domain.dnsRecord.name },
    { label: "Target", value: domain.dnsRecord.target },
    { label: "Proxy", value: "DNS only" },
  ]
}

export function getOwnershipRecords(domain: DocsDomainDto): VerificationRecord[] {
  return [
    domain.ownershipVerification?.type ? { label: "Ownership type", value: domain.ownershipVerification.type } : null,
    domain.ownershipVerification?.name ? { label: "Ownership name", value: domain.ownershipVerification.name } : null,
    domain.ownershipVerification?.value ? { label: "Ownership value", value: domain.ownershipVerification.value } : null,
    domain.ownershipVerificationHttp?.url ? { label: "HTTP URL", value: domain.ownershipVerificationHttp.url } : null,
    domain.ownershipVerificationHttp?.body ? { label: "HTTP body", value: domain.ownershipVerificationHttp.body } : null,
  ].filter(isVerificationRecord)
}

export function getSslValidationRecords(domain: DocsDomainDto): VerificationRecord[] {
  return domain.sslValidationRecords.flatMap((record, index) => {
    const suffix = domain.sslValidationRecords.length > 1 ? ` ${index + 1}` : ""
    return [
      record.status ? { label: `SSL status${suffix}`, value: record.status } : null,
      record.txtName ? { label: `SSL TXT name${suffix}`, value: record.txtName } : null,
      record.txtValue ? { label: `SSL TXT value${suffix}`, value: record.txtValue } : null,
      record.httpUrl ? { label: `SSL HTTP URL${suffix}`, value: record.httpUrl } : null,
      record.httpBody ? { label: `SSL HTTP body${suffix}`, value: record.httpBody } : null,
    ].filter(isVerificationRecord)
  })
}

export function isVerificationRecord(record: VerificationRecord | null): record is VerificationRecord {
  return record !== null
}

export function getProviderStatusTone(status: string): "muted" | "success" | "warning" | "danger" {
  if (status === "active") return "success"
  if (status === "blocked" || status === "deleted" || status === "failed" || status === "validation_timed_out") {
    return "danger"
  }
  if (status.includes("pending")) return "warning"
  return "muted"
}
