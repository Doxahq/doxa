import type { FormEventHandler } from "react"
import type {
  DocsDomainDto,
  GenerationJobDto,
  GitHubRepositoryDto,
  JobEventDto,
  ProjectDto,
} from "@doxahq/contracts"
import {
  ArrowUpRight,
  AlertCircle,
  Bot,
  CheckCircle2,
  Clock3,
  Github,
  GitBranch,
  Globe2,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  Rocket,
  Shield,
} from "lucide-react"

import {
  formatDataValue,
  formatElapsed,
  formatEventType,
  formatTime,
  getDnsRecords,
  getOwnershipRecords,
  getProviderStatusTone,
  getSslValidationRecords,
  type LoadState,
  type VerificationRecord,
} from "~/lib/dashboard/model"
import { DashboardNotice } from "~/components/dashboard/dashboard-feedback"
import { DocsDomainDeleteDialog } from "~/components/dashboard/docs-domain-delete-dialog"
import { DashboardPanel } from "~/components/dashboard/dashboard-shell"
import { DomainPill, JobStatusBadge } from "~/components/dashboard/dashboard-status"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Progress } from "~/components/ui/progress"
import { cn } from "~/lib/utils"

interface DashboardHeaderActionsProps {
  onSignIn: (provider: "google" | "github") => void
}

interface ConnectionPanelProps {
  githubInstallUrl: string
  localInstallCallbackUrl: string
  showLocalInstallCallback: boolean
}

interface RepositoriesPanelProps {
  repositories: GitHubRepositoryDto[]
  repositoriesError: string | null
  selectedRepositoryId: string
  selectedRepository: GitHubRepositoryDto | null
  onSelectRepository: (repositoryId: string) => void
  onCreateProject: () => void
}

interface ProjectsPanelProps {
  projects: ProjectDto[]
  activeProject: ProjectDto | null
  loadState: LoadState
  error: string | null
  onRefresh: () => void
  onSelectProject: (project: ProjectDto) => void
}

interface GeneratePanelProps {
  activeProject: ProjectDto | null
  docsUrl: string | null
  generationActive: boolean
  generationButtonLabel: string
  actionError: string | null
  onGenerateDocs: () => void
}

interface DomainsPanelProps {
  activeProject: ProjectDto | null
  docsDomains: DocsDomainDto[]
  domainsError: string | null
  domainHostname: string
  isCreatingDomain: boolean
  isLoadingDomains: boolean
  refreshingDomainId: string | null
  deletingDomainId: string | null
  onDomainHostnameChange: (hostname: string) => void
  onAddDocsDomain: FormEventHandler<HTMLFormElement>
  onRefreshDomain: (domainId: string) => void
  onDeleteDomain: (domainId: string) => Promise<string | null>
}

interface JobStatusPanelProps {
  job: GenerationJobDto | null
  events: JobEventDto[]
  generationActive: boolean
  docsUrl: string | null
  jobProgress: number
  latestEvent: JobEventDto | null
  elapsedLabel: string | null
}

export function DashboardHeaderActions({ onSignIn }: DashboardHeaderActionsProps) {
  return (
    <>
      <Button variant="outline" onClick={() => onSignIn("google")}>
        <Shield data-icon="inline-start" />
        Google
      </Button>
      <Button variant="outline" onClick={() => onSignIn("github")}>
        <Github data-icon="inline-start" />
        GitHub
      </Button>
    </>
  )
}

export function ConnectionPanel({
  githubInstallUrl,
  localInstallCallbackUrl,
  showLocalInstallCallback,
}: ConnectionPanelProps) {
  return (
    <DashboardPanel title="Connection" icon={<Github className="size-4" />}>
      <p className="text-sm leading-6 text-white/55">
        OAuth handles sign-in. GitHub App installation will populate repositories here.
      </p>
      <Button variant="default" className="mt-4 w-full" asChild>
        <a href={githubInstallUrl}>
          <Link2 data-icon="inline-start" />
          Connect GitHub App
        </a>
      </Button>
      {showLocalInstallCallback ? (
        <Button variant="outline" className="mt-2 w-full" asChild>
          <a href={localInstallCallbackUrl}>
            <GitBranch data-icon="inline-start" />
            Local install callback
          </a>
        </Button>
      ) : null}
    </DashboardPanel>
  )
}

export function RepositoriesPanel({
  repositories,
  repositoriesError,
  selectedRepositoryId,
  selectedRepository,
  onSelectRepository,
  onCreateProject,
}: RepositoriesPanelProps) {
  return (
    <DashboardPanel title="Repositories" icon={<GitBranch className="size-4" />}>
      {repositoriesError ? (
        <DashboardNotice message={repositoriesError} tone="error" />
      ) : repositories.length === 0 ? (
        <DashboardNotice message="No repositories yet. Install the GitHub App or seed a local repository." />
      ) : (
        <div className="flex flex-col gap-2">
          {repositories.map((repo) => (
            <button
              key={repo.id}
              type="button"
              onClick={() => onSelectRepository(repo.id)}
              className={cn(
                "w-full rounded-md border px-3 py-2 text-left text-xs transition-colors",
                selectedRepositoryId === repo.id
                  ? "border-primary bg-primary/10 text-white"
                  : "border-white/10 text-white/60 hover:border-white/25 hover:text-white",
              )}
            >
              {repo.fullName}
            </button>
          ))}
          <Button className="mt-3 w-full" onClick={onCreateProject} disabled={!selectedRepository}>
            <Rocket data-icon="inline-start" />
            Create project
          </Button>
        </div>
      )}
    </DashboardPanel>
  )
}

export function ProjectsPanel({
  projects,
  activeProject,
  loadState,
  error,
  onRefresh,
  onSelectProject,
}: ProjectsPanelProps) {
  return (
    <DashboardPanel
      title="Projects"
      icon={loadState === "loading" ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
      action={
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      }
    >
      {error ? <DashboardNotice message={error} tone="error" /> : null}
      {projects.length === 0 ? (
        <DashboardNotice message="Create a project from a linked GitHub repository to start generation." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelectProject(project)}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                activeProject?.id === project.id
                  ? "border-primary bg-primary/10"
                  : "border-white/10 hover:border-white/25",
              )}
            >
              <p className="text-sm font-semibold text-white uppercase">{project.name}</p>
              <p className="mt-2 text-xs text-white/45">/{project.slug}</p>
            </button>
          ))}
        </div>
      )}
    </DashboardPanel>
  )
}

export function GeneratePanel({
  activeProject,
  docsUrl,
  generationActive,
  generationButtonLabel,
  actionError,
  onGenerateDocs,
}: GeneratePanelProps) {
  return (
    <DashboardPanel title="Generate" icon={<Play className="size-4" />}>
      {activeProject ? (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm text-white">Ready to generate docs for {activeProject.name}.</p>
            <p className="mt-2 text-xs text-white/45">
              Publishing target: <span className="break-all text-white/70">{docsUrl}</span>
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button onClick={onGenerateDocs} disabled={generationActive}>
              {generationActive ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Bot data-icon="inline-start" />
              )}
              {generationButtonLabel}
            </Button>
            {actionError ? <DashboardNotice message={actionError} tone="error" /> : null}
          </div>
        </div>
      ) : (
        <DashboardNotice message="Select or create a project first." />
      )}
    </DashboardPanel>
  )
}

export function DomainsPanel({
  activeProject,
  docsDomains,
  domainsError,
  domainHostname,
  isCreatingDomain,
  isLoadingDomains,
  refreshingDomainId,
  deletingDomainId,
  onDomainHostnameChange,
  onAddDocsDomain,
  onRefreshDomain,
  onDeleteDomain,
}: DomainsPanelProps) {
  return (
    <DashboardPanel
      title="Domains"
      icon={isLoadingDomains ? <Loader2 className="size-4 animate-spin" /> : <Globe2 className="size-4" />}
    >
      {activeProject ? (
        <div className="flex flex-col gap-4">
          <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={onAddDocsDomain}>
            <input
              value={domainHostname}
              onChange={(event) => onDomainHostnameChange(event.currentTarget.value)}
              placeholder="docs.example.com"
              className="h-9 min-w-0 rounded-md border border-white/10 bg-black/40 px-3 font-mono text-sm text-white outline-none transition-colors placeholder:text-white/25 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
              disabled={isCreatingDomain}
            />
            <Button type="submit" disabled={isCreatingDomain || !domainHostname.trim()}>
              {isCreatingDomain ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Globe2 data-icon="inline-start" />
              )}
              Add domain
            </Button>
          </form>

          {domainsError ? <DashboardNotice message={domainsError} tone="error" /> : null}

          {isLoadingDomains ? (
            <DashboardNotice message="Loading docs domains." />
          ) : docsDomains.length === 0 ? (
            <DashboardNotice message="No custom domains connected for this project." />
          ) : (
            <div className="flex flex-col gap-2">
              {docsDomains.map((domain) => (
                <DocsDomainRow
                  key={domain.id}
                  domain={domain}
                  isRefreshing={refreshingDomainId === domain.id}
                  isDeleting={deletingDomainId === domain.id}
                  onRefresh={() => onRefreshDomain(domain.id)}
                  onDelete={() => onDeleteDomain(domain.id)}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <DashboardNotice message="Select or create a project first." />
      )}
    </DashboardPanel>
  )
}

export function JobStatusPanel({
  job,
  events,
  generationActive,
  docsUrl,
  jobProgress,
  latestEvent,
  elapsedLabel,
}: JobStatusPanelProps) {
  return (
    <DashboardPanel
      title="Job status"
      icon={generationActive ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
    >
      {job ? (
        <div className="flex flex-col gap-5">
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-start">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <JobStatusBadge status={job.status} />
                {elapsedLabel ? (
                  <span className="inline-flex items-center gap-2 rounded-sm border border-white/10 px-3 py-1 text-xs text-white/50">
                    <Clock3 className="size-3.5" />
                    {elapsedLabel}
                  </span>
                ) : null}
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-4 text-xs text-white/50">
                  <span>{latestEvent ? formatEventType(latestEvent.type) : "Waiting for first event"}</span>
                  <span>{jobProgress}%</span>
                </div>
                <Progress value={jobProgress} />
                {latestEvent ? (
                  <div className="mt-3 rounded-md border border-white/10 bg-white/[0.02] p-3">
                    <p className="mb-1 text-[10px] tracking-[0.16em] text-white/35 uppercase">Current event</p>
                    <p className="text-sm leading-6 text-white/70">{latestEvent.message}</p>
                  </div>
                ) : null}
              </div>
            </div>
            {docsUrl && job.status === "succeeded" ? (
              <div className="flex flex-col gap-2 md:min-w-[260px]">
                <Button variant="outline" size="sm" asChild>
                  <a href={docsUrl} target="_blank" rel="noreferrer">
                    Open docs
                    <ArrowUpRight data-icon="inline-end" />
                  </a>
                </Button>
                <p className="break-all rounded-md border border-white/10 p-2 text-xs leading-5 text-white/45">{docsUrl}</p>
              </div>
            ) : null}
          </div>
          {(job.status === "failed" || job.status === "cancelled") && job.errorMessage ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>
                {job.status === "cancelled" ? "Generation cancelled" : "Generation failed"}
              </AlertTitle>
              <AlertDescription>{job.errorMessage}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs tracking-[0.16em] text-white/45 uppercase">
              <span>Event log</span>
              <span>{events.length} entries</span>
            </div>
            {events.length === 0 ? (
              <DashboardNotice message="Waiting for job events." />
            ) : (
              <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
                {events.map((event) => (
                  <JobEventRow key={event.id} event={event} />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <DashboardNotice message="No generation job has been started in this session." />
      )}
    </DashboardPanel>
  )
}

function DocsDomainRow({
  domain,
  isRefreshing,
  isDeleting,
  onRefresh,
  onDelete,
}: {
  domain: DocsDomainDto
  isRefreshing: boolean
  isDeleting: boolean
  onRefresh: () => void
  onDelete: () => Promise<string | null>
}) {
  const canDelete = domain.kind === "custom_domain"
  const canRefresh = domain.kind === "custom_domain" && domain.status !== "disabled"

  return (
    <div className="rounded-md border border-white/10 bg-black/30 px-3 py-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 break-all font-mono text-sm text-white">{domain.hostname}</p>
            <DomainPill label={domain.kind === "custom_domain" ? "custom" : "doxa"} />
            {domain.provider ? <DomainPill label={domain.provider} /> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <DomainPill label={domain.status} tone={domain.status === "active" ? "success" : "muted"} />
            <DomainPill
              label={domain.verificationStatus}
              tone={
                domain.verificationStatus === "verified"
                  ? "success"
                  : domain.verificationStatus === "failed"
                    ? "danger"
                    : "warning"
              }
            />
            {domain.providerStatus ? (
              <DomainPill label={`host ${domain.providerStatus}`} tone={getProviderStatusTone(domain.providerStatus)} />
            ) : null}
            {domain.providerSslStatus ? (
              <DomainPill label={`ssl ${domain.providerSslStatus}`} tone={getProviderStatusTone(domain.providerSslStatus)} />
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={!canRefresh || isRefreshing || isDeleting}
          >
            {isRefreshing ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            Refresh
          </Button>
          <DocsDomainDeleteDialog
            hostname={domain.hostname}
            disabled={!canDelete || isRefreshing || isDeleting}
            isDeleting={isDeleting}
            onDelete={onDelete}
          />
        </div>
      </div>
      <DocsDomainVerificationDetails domain={domain} />
    </div>
  )
}

function DocsDomainVerificationDetails({ domain }: { domain: DocsDomainDto }) {
  const dnsRecords = getDnsRecords(domain)
  const ownershipRecords = getOwnershipRecords(domain)
  const sslRecords = getSslValidationRecords(domain)
  const shouldRender =
    dnsRecords.length > 0 ||
    domain.provider ||
    ownershipRecords.length > 0 ||
    sslRecords.length > 0 ||
    domain.verificationError
  if (!shouldRender) return null

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-white/10 pt-3">
      {domain.verificationError ? <DashboardNotice message={domain.verificationError} tone="error" /> : null}
      {dnsRecords.length > 0 ? (
        <VerificationRecordGroup title="DNS" records={dnsRecords} />
      ) : null}
      {ownershipRecords.length > 0 ? (
        <VerificationRecordGroup title="Ownership" records={ownershipRecords} />
      ) : null}
      {sslRecords.length > 0 ? (
        <VerificationRecordGroup title="Certificate" records={sslRecords} />
      ) : null}
      {ownershipRecords.length === 0 && sslRecords.length === 0 && domain.provider ? (
        <DashboardNotice message="Waiting for verification records." />
      ) : null}
    </div>
  )
}

function VerificationRecordGroup({
  title,
  records,
}: {
  title: string
  records: VerificationRecord[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] tracking-[0.16em] text-white/35 uppercase">{title}</p>
      <dl className="grid gap-2 md:grid-cols-2">
        {records.map((record) => (
          <div key={`${record.label}:${record.value}`} className="min-w-0 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
            <dt className="text-[10px] tracking-[0.14em] text-white/35 uppercase">{record.label}</dt>
            <dd className="mt-1 break-all font-mono text-xs leading-5 text-white/70">{record.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function JobEventRow({ event }: { event: JobEventDto }) {
  const elapsedMs = typeof event.data?.elapsedMs === "number" ? event.data.elapsedMs : null
  const dataEntries = event.data
    ? Object.entries(event.data).filter(([key, value]) =>
        value !== null &&
        value !== undefined &&
        key !== "elapsedMs" &&
        key !== "containerSequence",
      )
    : []

  return (
    <div className="rounded-md border border-white/10 bg-black/30 px-3 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-sm border border-white/10 px-2 py-0.5 text-white/35">#{event.sequence}</span>
          <span className="rounded-sm border border-white/10 px-2 py-0.5 text-white/45">{event.source}</span>
          <span className={cn("tracking-[0.14em] uppercase", event.type === "failed" ? "text-destructive" : "text-primary")}>
            {formatEventType(event.type)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-white/35">
          {elapsedMs !== null ? <span>{formatElapsed(elapsedMs)}</span> : null}
          <span>{formatTime(event.createdAt)}</span>
        </div>
      </div>
      <p className="mt-2 leading-5 text-white/65">{event.message}</p>
      {dataEntries.length > 0 ? (
        <dl className="mt-3 grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-2">
          {dataEntries.slice(0, 6).map(([key, value]) => (
            <div key={key}>
              <dt className="text-white/35 uppercase">{formatEventType(key)}</dt>
              <dd className="mt-1 break-words text-white/65">{formatDataValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
