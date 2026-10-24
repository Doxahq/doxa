import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUpCircle,
  Bot,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Github,
  GitPullRequestArrow,
  Globe,
  Link2,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  StepForward,
  Trash2,
} from "lucide-react"
import type {
  GenerationActionBlockedReason,
  GenerationDeploymentState,
  GenerationDetailDto,
  GenerationDomainDto,
  GenerationRerunLinksDto,
  JobEventDto,
} from "@doxahq/contracts"

import {
  MetaField,
  PageBody,
  SectionDescription,
  SectionLabel,
} from "~/components/dashboard/dashboard-header"
import { ExpandableCard } from "~/components/dashboard/expandable-card"
import { GenerationActionDialog } from "~/components/dashboard/generation-action-dialog"
import { JobStatusBadge } from "~/components/dashboard/dashboard-status"
import { GenerationCancelDialog } from "~/components/dashboard/generation-cancel-dialog"
import { GenerationStartConfirmationDialog } from "~/components/dashboard/generation-start-confirmation-dialog"
import { GenerationsBackNavigation } from "~/components/dashboard/page-back-navigation"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar"
import { Badge, badgeVariants } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip"
import {
  canCancelGeneration,
  formatGenerationDuration,
  getActionBlockedMessage,
  getDomainRoleLabel,
  getGenerationTitle,
  getRerunLinks,
  hasReadableChanges,
  shortenGenerationId,
} from "~/lib/dashboard/generation-model"
import { formatEventType } from "~/lib/dashboard/model"
import type { GenerationStreamStatus } from "~/lib/dashboard/generation-stream-context"
import { ROLE_RESTRICTED_MESSAGE, useProjectCapabilities, type ProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useGenerationStarter } from "~/lib/dashboard/use-generation-starter"
import { useProjectGeneration } from "~/lib/dashboard/use-project-generation"
import { ProjectGenerationSkeleton } from "~/components/dashboard/skeletons/project-skeletons"
import { cn } from "~/lib/utils"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { readFlaggedPages } from "~/lib/dashboard/flagged-pages"
import { GenerationFlaggedPages } from "~/components/dashboard/generation-flagged-pages"
import { readReferenceSource } from "~/lib/dashboard/reference-source"
import { GenerationSpecProblems } from "~/components/dashboard/generation-spec-problems"

const GENERATION_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
})

const LOG_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

const MAX_VISIBLE_DOMAINS = 3

const DOMAIN_ROLE_ICONS = {
  production: Globe,
  generated: GitBranch,
  preview: GitPullRequestArrow,
  permanent: Link2,
} satisfies Record<GenerationDomainDto["role"], typeof Globe>

export function ProjectGenerationPage({
  projectId,
  generationId,
}: {
  projectId: string
  generationId: string
}) {
  const navigate = useNavigate()
  const state = useProjectGeneration(projectId, generationId)
  const capabilities = useProjectCapabilities(projectId)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // A re-run answers like a start, so it opens the new run and asks the same questions.
  const { startGeneration: rerunGeneration, confirmationDialogProps } = useGenerationStarter(projectId, {
    start: state.rerun,
    isStarting: state.isRerunning,
    startError: state.rerunError,
  })
  const canRerun = capabilities.can("generation.run") && state.generation?.actions.canRerun === true
  // An older API sends no `canResume`, which reads as false.
  const canResume = capabilities.can("generation.run") && state.generation?.actions.canResume === true
  const rerunLinks = state.generation ? getRerunLinks(state.generation) : null
  // A run that did not finish its work leads with running it again. A
  // succeeded run leads with its site and keeps Re-run in the menu.
  const leadsWithRerun = state.generation?.status === "failed" || state.generation?.status === "cancelled"

  async function deleteGeneration(): Promise<boolean> {
    const deleted = await state.remove()
    if (!deleted) return false
    await navigate({
      to: "/dashboard/projects/$projectId/generations",
      params: { projectId },
    })
    return true
  }

  // The skeleton is for the first load only (see `useIsFirstLoad`).
  const isFirstLoad = useIsFirstLoad([{ isPending: state.isPending }])
  if (isFirstLoad) return <ProjectGenerationSkeleton />

  return (
    <PageBody className="max-w-7xl">
      <GenerationsBackNavigation projectId={projectId} />

      {state.error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Could not load generation</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {state.rerunError && !confirmationDialogProps.open ? (
        <Alert variant="destructive" aria-live="polite">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Could not run the generation again</AlertTitle>
          <AlertDescription>{state.rerunError}</AlertDescription>
        </Alert>
      ) : null}

      {state.resumeError ? (
        <Alert variant="destructive" aria-live="polite">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Could not continue the generation</AlertTitle>
          <AlertDescription>{state.resumeError}</AlertDescription>
        </Alert>
      ) : null}

      {state.generation ? (
        <>
          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex flex-col gap-1.5">
                <SectionLabel>{getGenerationTitle(state.generation)}</SectionLabel>
                <SectionDescription>
                  Deployment details, source identity, and generation output.
                </SectionDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {capabilities.can("generation.run") ? (
                  <GenerationCancelDialog
                    canCancel={canCancelGeneration(state.generation)}
                    isCancelling={state.isCancelling}
                    error={state.cancelError}
                    onCancel={state.cancel}
                    onReset={state.resetCancel}
                  />
                ) : null}
                {state.generation.actions.promoteBlockedReason === "review_required" ? (
                  <Button size="sm" asChild>
                    <Link to="/dashboard/projects/$projectId/content" params={{ projectId }} search={{ review: true }}>
                      <ClipboardCheck aria-hidden="true" />
                      Review changes
                    </Link>
                  </Button>
                ) : leadsWithRerun && rerunLinks?.rerunId ? (
                  // The run already ran again, so the next step is the new run.
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      to="/dashboard/projects/$projectId/generations/$generationId"
                      params={{ projectId, generationId: rerunLinks.rerunId }}
                    >
                      <ArrowRight aria-hidden="true" />
                      Open re-run
                    </Link>
                  </Button>
                ) : canResume ? (
                  // The failed step can run again with every earlier step kept.
                  <Button size="sm" disabled={state.isResuming} onClick={() => void state.resume()}>
                    {state.isResuming ? (
                      <Loader2 aria-hidden="true" className="animate-spin" />
                    ) : (
                      <StepForward aria-hidden="true" />
                    )}
                    {state.isResuming ? "Continuing…" : "Continue run"}
                  </Button>
                ) : leadsWithRerun && canRerun ? (
                  <Button size="sm" disabled={state.isRerunning} onClick={() => void rerunGeneration()}>
                    {state.isRerunning ? (
                      <Loader2 aria-hidden="true" className="animate-spin" />
                    ) : (
                      <RotateCcw aria-hidden="true" />
                    )}
                    {state.isRerunning ? "Starting…" : "Re-run"}
                  </Button>
                ) : (
                  <>
                    {hasReadableChanges(state.generation) ? (
                      <Button variant="outline" size="sm" asChild>
                        <Link
                          to="/dashboard/projects/$projectId/generations/$generationId/changes"
                          params={{ projectId, generationId }}
                        >
                          <FileDiff aria-hidden="true" />
                          View changes
                        </Link>
                      </Button>
                    ) : null}
                    <VisitGenerationButton
                      visitUrl={state.generation.deployment.visitUrl}
                    />
                  </>
                )}
                <GenerationActionsMenu
                  generation={state.generation}
                  capabilities={capabilities}
                  onResume={() => void state.resume()}
                  onRerun={() => void rerunGeneration()}
                  onPromote={() => setPromoteOpen(true)}
                  onDelete={() => setDeleteOpen(true)}
                />
              </div>
            </div>
            <div className="surface-card p-5 sm:p-6">
              <dl className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
                <MetaField label="Created">
                  <GenerationAuthor generation={state.generation} />
                </MetaField>
                <MetaField label="Status">
                  <div className="flex flex-col items-start gap-2">
                    <JobStatusBadge status={state.generation.status} />
                    <GenerationRerunLinks
                      projectId={projectId}
                      links={getRerunLinks(state.generation)}
                    />
                  </div>
                </MetaField>
                <MetaField label="Duration">
                  <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                    <Clock3
                      aria-hidden="true"
                      className="size-3.5 text-muted-foreground"
                    />
                    {formatGenerationDuration(state.durationMs)}
                  </span>
                </MetaField>
                <MetaField label="Environment">
                  <GenerationEnvironment generation={state.generation} />
                </MetaField>
                <MetaField label="Domains" className="sm:col-span-2">
                  <GenerationDomains
                    domains={state.generation.deployment.domains}
                  />
                </MetaField>
                <MetaField label="Source" className="sm:col-span-2">
                  <GenerationSource generation={state.generation} />
                </MetaField>
              </dl>
            </div>

            {(state.generation.status === "failed" || state.generation.status === "cancelled") && state.generation.errorMessage ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>
                  {state.generation.status === "cancelled" ? "Generation cancelled" : "Generation failed"}
                </AlertTitle>
                <AlertDescription className="break-words">
                  {state.generation.errorMessage}
                </AlertDescription>
              </Alert>
            ) : null}

            <GenerationSpecProblems report={readReferenceSource(state.generation)} />
            <GenerationFlaggedPages pages={readFlaggedPages(state.generation)} />
          </section>

          <GenerationEventLog
            events={state.events}
            streamStatus={state.streamStatus}
          />

          <GenerationActionDialog
            action="promote"
            environmentLabel="Production"
            open={promoteOpen}
            onOpenChange={setPromoteOpen}
            isPending={state.isPromoting}
            error={state.promoteError}
            onConfirm={state.promote}
          />
          <GenerationActionDialog
            action="delete"
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            isPending={state.isDeleting}
            error={state.deleteError}
            onConfirm={deleteGeneration}
          />
          <GenerationStartConfirmationDialog {...confirmationDialogProps} />
        </>
      ) : null}
    </PageBody>
  )
}

/** Links the run to the failed run it started again, and to its own re-run. */
function GenerationRerunLinks({
  projectId,
  links,
}: {
  projectId: string
  links: GenerationRerunLinksDto
}) {
  return (
    <>
      {links.rerunOfId ? (
        <GenerationRerunLink projectId={projectId} label="Re-run of" generationId={links.rerunOfId} />
      ) : null}
      {links.rerunId ? (
        <GenerationRerunLink projectId={projectId} label="Re-run as" generationId={links.rerunId} />
      ) : null}
    </>
  )
}

function GenerationRerunLink({
  projectId,
  label,
  generationId,
}: {
  projectId: string
  label: string
  generationId: string
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <RotateCcw aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
      <Link
        to="/dashboard/projects/$projectId/generations/$generationId"
        params={{ projectId, generationId }}
        title="View generation"
        className="truncate font-mono text-primary-text underline-offset-2 hover:underline focus-visible:underline"
      >
        {shortenGenerationId(generationId)}
      </Link>
    </span>
  )
}

function VisitGenerationButton({ visitUrl }: { visitUrl: string | null }) {
  const button = (
    <Button
      variant="outline"
      size="sm"
      asChild={Boolean(visitUrl)}
      disabled={!visitUrl}
    >
      {visitUrl ? (
        <a href={visitUrl} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden="true" />
          Visit
        </a>
      ) : (
        <>
          <ExternalLink aria-hidden="true" />
          Visit
        </>
      )}
    </Button>
  )
  if (visitUrl) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        This generation is no longer served on any domain.
      </TooltipContent>
    </Tooltip>
  )
}

function GenerationActionsMenu({
  generation,
  capabilities,
  onResume,
  onRerun,
  onPromote,
  onDelete,
}: {
  generation: GenerationDetailDto
  capabilities: ProjectCapabilities
  onResume: () => void
  onRerun: () => void
  onPromote: () => void
  onDelete: () => void
}) {
  return (
    // `modal={false}` keeps the menu from locking `pointer-events` on the body.
    // A modal menu and the dialog it opens both manage that lock, and the menu
    // unmounts last, so it restores a value the dialog still needs. The page
    // then ignores every click. A non-modal menu never takes the lock.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Generation actions">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {generation.status === "failed" ? (
          <GenerationActionItem
            icon={<StepForward aria-hidden="true" />}
            label="Continue from failed step"
            blockedMessage={
              !capabilities.can("generation.run")
                ? ROLE_RESTRICTED_MESSAGE
                : blockedMessageOf(
                    generation.actions.canResume === true,
                    generation.actions.resumeBlockedReason ?? "not_resumable",
                  )
            }
            onSelect={onResume}
          />
        ) : null}
        <GenerationActionItem
          icon={<RotateCcw aria-hidden="true" />}
          label="Re-run generation"
          blockedMessage={
            !capabilities.can("generation.run")
              ? ROLE_RESTRICTED_MESSAGE
              : blockedMessageOf(generation.actions.canRerun, generation.actions.rerunBlockedReason)
          }
          onSelect={onRerun}
        />
        <GenerationActionItem
          icon={<ArrowUpCircle aria-hidden="true" />}
          label="Promote"
          blockedMessage={
            !capabilities.can("docs.publish")
              ? ROLE_RESTRICTED_MESSAGE
              : blockedMessageOf(generation.actions.canPromote, generation.actions.promoteBlockedReason)
          }
          onSelect={onPromote}
        />
        <DropdownMenuSeparator />
        <GenerationActionItem
          icon={<Trash2 aria-hidden="true" />}
          label="Delete generation"
          blockedMessage={
            !capabilities.can("generation.run")
              ? ROLE_RESTRICTED_MESSAGE
              : blockedMessageOf(generation.actions.canDelete, generation.actions.deleteBlockedReason)
          }
          onSelect={onDelete}
          className="text-destructive focus:text-destructive"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One menu action. A blocked action stays visible and focusable, and explains
 * itself through a tooltip. It uses `aria-disabled` instead of `disabled`,
 * because a `disabled` menu item drops pointer events and can never open a
 * tooltip.
 */
function blockedMessageOf(allowed: boolean, reason: GenerationActionBlockedReason | null): string | null {
  return allowed || reason === null ? null : getActionBlockedMessage(reason)
}

function GenerationActionItem({
  icon,
  label,
  blockedMessage,
  onSelect,
  className,
}: {
  icon: ReactNode
  label: string
  /** Why the action is blocked, shown in a tooltip; null when it can run. */
  blockedMessage: string | null
  onSelect: () => void
  className?: string
}) {
  const item = (
    <DropdownMenuItem
      aria-disabled={blockedMessage !== null}
      onSelect={(event) => {
        if (blockedMessage !== null) {
          event.preventDefault()
          return
        }
        onSelect()
      }}
      className={cn(
        blockedMessage !== null && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {icon}
      {label}
    </DropdownMenuItem>
  )

  if (blockedMessage === null) return item

  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-64">
        {blockedMessage}
      </TooltipContent>
    </Tooltip>
  )
}

function GenerationAuthor({
  generation,
}: {
  generation: GenerationDetailDto
}) {
  const author = generation.author
  return (
    <div className="flex flex-wrap items-center gap-2">
      {author.kind === "automation" ? (
        <span className="inline-flex size-5 items-center justify-center rounded-sm border border-border">
          <Bot aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </span>
      ) : (
        <Avatar className="size-5">
          {author.avatarUrl ? (
            <AvatarImage src={author.avatarUrl} alt="" />
          ) : null}
          <AvatarFallback className="text-[10px]">
            {author.displayName.charAt(0).toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
      )}
      <span className="truncate font-mono text-sm">
        {author.displayName}
      </span>
      <time
        dateTime={generation.createdAt}
        className="text-sm text-muted-foreground"
      >
        {GENERATION_DATE_FORMAT.format(new Date(generation.createdAt))}
      </time>
    </div>
  )
}

function GenerationDomains({ domains }: { domains: GenerationDomainDto[] }) {
  const [showAll, setShowAll] = useState(false)
  if (domains.length === 0) {
    return <span className="text-sm text-muted-foreground">No domain</span>
  }
  const visibleDomains = showAll
    ? domains
    : domains.slice(0, MAX_VISIBLE_DOMAINS)
  const hiddenCount = domains.length - visibleDomains.length
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      {visibleDomains.map((domain) => (
        <GenerationDomainLink key={`${domain.role}:${domain.hostname}`} domain={domain} />
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className={badgeVariants({ variant: "muted" })}
        >
          +{hiddenCount}
        </button>
      ) : null}
    </div>
  )
}

function GenerationDomainLink({ domain }: { domain: GenerationDomainDto }) {
  const Icon = DOMAIN_ROLE_ICONS[domain.role]
  return (
    <a
      href={domain.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`${getDomainRoleLabel(domain.role)} domain ${domain.hostname}`}
      className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground underline-offset-4 hover:underline focus-visible:underline"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs">{domain.hostname}</span>
    </a>
  )
}

function GenerationEnvironment({
  generation,
}: {
  generation: GenerationDetailDto
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ArrowUpCircle aria-hidden="true" className="size-3.5 text-muted-foreground" />
      <span>
        {generation.deployment.environment === "production"
          ? "Production"
          : "Preview"}
      </span>
      <DeploymentStateBadge generation={generation} />
    </div>
  )
}

const DEPLOYMENT_STATE_BADGES: Record<
  GenerationDeploymentState,
  { label: string; variant: "success" | "warning" | "muted"; description: string }
> = {
  live: { label: "Live", variant: "success", description: "This generation is live." },
  in_review: {
    label: "In review",
    variant: "warning",
    description: "This generation waits in a review. Publishing the review makes it live.",
  },
  replaced: {
    label: "Replaced",
    variant: "muted",
    description: "This generation was live. A newer version replaced it.",
  },
  not_published: {
    label: "Not published",
    variant: "muted",
    description: "This generation never went live.",
  },
}

/** What happened to the version of the generation: live, in review, replaced, or never published. */
function DeploymentStateBadge({ generation }: { generation: GenerationDetailDto }) {
  const badge = DEPLOYMENT_STATE_BADGES[generation.deployment.state]
  return (
    <Badge variant={badge.variant} title={badge.description}>
      {badge.label}
    </Badge>
  )
}

function GenerationSource({ generation }: { generation: GenerationDetailDto }) {
  const source = generation.source
  const hasSource = Boolean(
    source.repositoryFullName ||
      source.branch ||
      source.commit ||
      source.changeProposal,
  )
  if (!hasSource) {
    return <span className="text-sm text-muted-foreground">No source information</span>
  }
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      {source.repositoryFullName ? (
        <SourceLine
          icon={Github}
          label={source.repositoryFullName}
          url={source.repositoryUrl}
        />
      ) : null}
      {source.branch ? (
        <SourceLine icon={GitBranch} label={source.branch} url={source.branchUrl} />
      ) : null}
      {source.commit ? (
        <SourceLine
          icon={GitCommitHorizontal}
          label={source.commit.shortRevision}
          url={source.commit.url}
          detail={source.commit.message}
          mono
        />
      ) : null}
      {source.changeProposal ? (
        <SourceLine
          icon={GitPullRequestArrow}
          label={`#${source.changeProposal.number}`}
          url={source.changeProposal.url}
          mono
        />
      ) : null}
    </div>
  )
}

function SourceLine({
  icon: Icon,
  label,
  url,
  detail,
  mono = false,
}: {
  icon: typeof GitBranch
  label: string
  url?: string | null
  detail?: string | null
  mono?: boolean
}) {
  const content = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn("truncate text-xs", mono && "font-mono")}>
        {label}
      </span>
      {detail ? <span className="truncate text-muted-foreground">{detail}</span> : null}
    </>
  )
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground underline-offset-4 hover:underline focus-visible:underline"
    >
      {content}
    </a>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground">
      {content}
    </span>
  )
}

function GenerationEventLog({
  events,
  streamStatus,
}: {
  events: JobEventDto[]
  streamStatus: GenerationStreamStatus
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLOListElement>(null)
  const previousCountRef = useRef(0)
  const [isFollowing, setIsFollowing] = useState(true)
  const [unseenCount, setUnseenCount] = useState(0)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    const addedCount = Math.max(0, events.length - previousCountRef.current)
    previousCountRef.current = events.length
    if (addedCount === 0) return

    if (!isFollowing) {
      setUnseenCount((current) => current + addedCount)
      return
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [events.length, isFollowing])

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content || !isFollowing || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(() => {
      viewport.scrollTop = viewport.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [events.length, isFollowing])

  function handleScroll(): void {
    const viewport = viewportRef.current
    if (!viewport) return

    const isNearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48
    setIsFollowing(isNearBottom)
    if (isNearBottom) setUnseenCount(0)
  }

  function resumeFollowing(): void {
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
    setIsFollowing(true)
    setUnseenCount(0)
  }

  return (
    <ExpandableCard
      title="Generation log"
      open={open}
      onOpenChange={setOpen}
      meta={
        <>
            <StreamStatus status={streamStatus} />
            <span className="font-mono text-[10px] tabular-nums tracking-[0.14em] text-label uppercase">
              {events.length} {events.length === 1 ? "line" : "lines"}
            </span>
        </>
      }
    >
      <div className="flex h-[clamp(420px,70dvh,760px)] flex-col overflow-hidden bg-sidebar">

        <div className="relative min-h-0 flex-1">
          <div
            ref={viewportRef}
            role="log"
            aria-label="Generation build output"
            aria-live="polite"
            aria-relevant="additions"
            onScroll={handleScroll}
            className="scrollbar-subtle h-full overflow-y-auto overscroll-contain p-4"
          >
            {events.length > 0 ? (
              <ol ref={contentRef} className="flex flex-col gap-1">
                {events.map((event) => (
                  <li key={event.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_24px]">
                    <GenerationEventLine event={event} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="font-mono text-xs leading-6 text-muted-foreground">
                <span className="text-label">$</span> Waiting for generation events…
              </p>
            )}
          </div>

          {unseenCount > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={resumeFollowing}
              className="absolute right-4 bottom-4 rounded-md border border-border bg-card text-foreground shadow-lg hover:bg-surface-hover"
            >
              <ArrowDown aria-hidden="true" />
              {unseenCount} new {unseenCount === 1 ? "log" : "logs"}
            </Button>
          ) : null}
        </div>
      </div>
    </ExpandableCard>
  )
}

function StreamStatus({ status }: { status: GenerationStreamStatus }) {
  const label = status === "live"
    ? "Live"
    : status === "connecting"
      ? "Connecting"
      : status === "fallback"
        ? "Polling"
        : status === "complete"
          ? "Complete"
          : "Idle"

  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-label",
          status === "live" && "bg-success motion-safe:animate-pulse",
          status === "fallback" && "bg-warning",
        )}
      />
      {label}
    </span>
  )
}

function GenerationEventLine({ event }: { event: JobEventDto }) {
  const elapsedMs = typeof event.data?.elapsedMs === "number" ? event.data.elapsedMs : null

  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 font-mono text-xs leading-6">
      <time
        dateTime={event.createdAt}
        className="tabular-nums text-label"
      >
        {LOG_TIME_FORMAT.format(new Date(event.createdAt))}
      </time>
      <p className="min-w-0 break-words text-body">
        <span className="text-label">{event.source}</span>
        <span className="ml-2 text-label">#{event.sequence}</span>
        <span
          className={cn(
            "ml-3",
            event.level === "error"
              ? "text-destructive"
              : event.level === "warning"
                ? "text-warning"
                : "text-body",
          )}
        >
          {formatEventType(event.type)}
        </span>
        <span className="mx-2 text-label/60">›</span>
        <span>{event.message}</span>
        {elapsedMs !== null ? (
          <span className="ml-2 tabular-nums text-label">
            +{formatGenerationDuration(elapsedMs)}
          </span>
        ) : null}
      </p>
    </div>
  )
}
