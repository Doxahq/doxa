import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { DocsDomainDto, DoxabotSettingsDto, GenerationJobDto, PendingMerges } from "@doxahq/contracts"
import type { ApprovalRequestSummary } from "@doxahq/contracts/approval-requests"
import type { GenerationReview } from "@doxahq/contracts/generation-reviews"
import { Bot, Check, CircleX, ClipboardCheck, FileWarning, GitMerge, Globe, type LucideIcon } from "lucide-react"

import { plural } from "~/components/dashboard/content/branches/publish-menu-parts"
import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { Button } from "~/components/ui/button"
import { pendingMergesNextStep } from "~/lib/dashboard/doxabot-merge-model"
import { getDocsDomainStatus } from "~/lib/dashboard/domain-status"
import { cn } from "~/lib/utils"

const MAX_LISTED_MERGES = 5

type AttentionTone = "primary" | "warning" | "danger"

const TONE_CLASS: Record<AttentionTone, string> = {
  primary: "bg-primary-wash text-primary-text",
  warning: "bg-warning/10 text-warning",
  danger: "bg-destructive/10 text-destructive",
}

export interface AttentionItem {
  id: string
  tone: AttentionTone
  icon: LucideIcon
  title: string
  detail: string
  action: ReactNode
}

export interface AttentionQueueInput {
  projectId: string
  review: GenerationReview | null
  merges: PendingMerges["merges"]
  doxabot: DoxabotSettingsDto | null
  approvals: readonly ApprovalRequestSummary[]
  mdxPageCount: number
  latestJob: GenerationJobDto | null
  domains: readonly DocsDomainDto[]
  /** Null for a role that cannot run generations. */
  onGenerate: (() => void) | null
  isGenerating: boolean
}

function actionLink(link: ReactNode): ReactNode {
  return (
    <Button variant="outline" size="sm" className="shrink-0" asChild>
      {link}
    </Button>
  )
}

function reviewItem({ projectId, review }: AttentionQueueInput): AttentionItem | null {
  if (!review) return null
  return {
    id: "review",
    tone: "primary",
    icon: ClipboardCheck,
    title: "A generation waits for your review",
    detail: `It changes ${plural(review.pages.length, "page")}. Your live site does not change until you publish.`,
    action: actionLink(
      <Link to="/dashboard/projects/$projectId/content" params={{ projectId }} search={{ review: true }}>
        Review changes
      </Link>,
    ),
  }
}

function mergesItem({ merges, doxabot, onGenerate, isGenerating }: AttentionQueueInput): AttentionItem | null {
  if (merges.length === 0) return null
  const numbers = merges.slice(0, MAX_LISTED_MERGES).map((merge) => `#${merge.number}`).join(", ")
  const more = merges.length > MAX_LISTED_MERGES ? ` and ${merges.length - MAX_LISTED_MERGES} more` : ""
  return {
    id: "merges",
    tone: "warning",
    icon: GitMerge,
    title: `${plural(merges.length, "merged pull request")} not in your docs yet`,
    detail: `${numbers}${more}. ${doxabot ? pendingMergesNextStep(doxabot) : "Generate to bring them into your docs."}`,
    action: onGenerate ? (
      <Button variant="outline" size="sm" className="shrink-0" disabled={isGenerating} onClick={onGenerate}>
        Update docs
      </Button>
    ) : null,
  }
}

function approvalsItem({ projectId, approvals }: AttentionQueueInput): AttentionItem | null {
  const first = approvals[0]
  if (!first) return null
  const isSingle = approvals.length === 1
  return {
    id: "approvals",
    tone: "primary",
    icon: Bot,
    title: isSingle
      ? `${first.requestedBy.clientName}: ${first.title}`
      : `${approvals.length} agent requests wait for a decision`,
    detail: isSingle ? first.headline : `The first one: ${first.title}`,
    action: isSingle
      ? actionLink(
          <Link to="/dashboard/projects/$projectId/requests/$requestId" params={{ projectId, requestId: first.id }}>
            Open request
          </Link>,
        )
      : actionLink(
          <Link to="/dashboard/projects/$projectId/requests" params={{ projectId }}>
            Open requests
          </Link>,
        ),
  }
}

function mdxItem({ projectId, mdxPageCount }: AttentionQueueInput): AttentionItem | null {
  if (mdxPageCount === 0) return null
  return {
    id: "mdx",
    tone: "danger",
    icon: FileWarning,
    title: `${plural(mdxPageCount, "changed page")} with MDX problems`,
    detail: "A publish that includes these pages is blocked.",
    action: actionLink(
      <Link to="/dashboard/projects/$projectId/content" params={{ projectId }}>
        Fix pages
      </Link>,
    ),
  }
}

function failedGenerationItem({ projectId, latestJob }: AttentionQueueInput): AttentionItem | null {
  if (latestJob?.status !== "failed") return null
  return {
    id: "failed-generation",
    tone: "danger",
    icon: CircleX,
    title: "The last generation failed",
    detail: "Your live site did not change. Open the run to see what went wrong.",
    action: actionLink(
      <Link
        to="/dashboard/projects/$projectId/generations/$generationId"
        params={{ projectId, generationId: latestJob.id }}
      >
        View run
      </Link>,
    ),
  }
}

function domainItem({ projectId, domains }: AttentionQueueInput): AttentionItem | null {
  const unhealthy = domains.filter((domain) => {
    if (domain.kind !== "custom_domain") return false
    const { label } = getDocsDomainStatus(domain).overall
    return label === "Needs attention" || label === "Setting up"
  })
  const first = unhealthy[0]
  if (!first) return null
  const status = getDocsDomainStatus(first)
  return {
    id: "domain",
    tone: status.overall.tone === "danger" ? "danger" : "warning",
    icon: Globe,
    title: `${first.hostname} is not ready`,
    detail: status.summary,
    action: actionLink(
      <Link to="/dashboard/projects/$projectId/site/domains" params={{ projectId }}>
        Open domains
      </Link>,
    ),
  }
}

const ITEM_BUILDERS = [reviewItem, mergesItem, approvalsItem, mdxItem, failedGenerationItem, domainItem]

export function buildAttentionItems(input: AttentionQueueInput): AttentionItem[] {
  return ITEM_BUILDERS.flatMap((build) => build(input) ?? [])
}

/** Says that the queue is empty, so its absence does not read as a failed load. */
export function AttentionAllClear({ hasRepository }: { hasRepository: boolean }) {
  return (
    <section aria-label="Status" className="surface-card flex items-center gap-3.5 px-5 py-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-success/10 text-success">
        <Check aria-hidden="true" className="size-4" />
      </span>
      <p className="text-sm text-foreground">
        Nothing needs you right now.{hasRepository ? " Your docs match your latest merge." : ""}
      </p>
    </section>
  )
}

/** One list of what needs a person now, so nothing hides on another page. */
export function AttentionQueue({ items }: { items: readonly AttentionItem[] }) {
  if (items.length === 0) return null

  return (
    <section aria-labelledby="attention-title" className="flex flex-col gap-3">
      <SectionLabel className="flex items-center gap-2.5">
        <span id="attention-title">Needs your attention</span>
        <span className="rounded-sm bg-warning/10 px-1.5 tracking-normal text-warning">{items.length}</span>
      </SectionLabel>
      <ul className="surface-card">
        {items.map((item, index) => (
          <li
            key={item.id}
            className={cn(
              "flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center",
              index > 0 && "border-t border-divider",
            )}
          >
            <div className="flex min-w-0 flex-1 items-center gap-3.5">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", TONE_CLASS[item.tone])}>
                <item.icon aria-hidden="true" className="size-4" />
              </span>
              <div className="flex min-w-0 flex-col">
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                <p className="text-[13px] leading-5 text-pretty text-muted-foreground">{item.detail}</p>
              </div>
            </div>
            {item.action}
          </li>
        ))}
      </ul>
    </section>
  )
}
