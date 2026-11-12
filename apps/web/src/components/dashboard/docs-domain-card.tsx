import {
  AlertCircle,
  Check,
  CircleDashed,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"
import type { DocsDomainDto } from "@doxahq/contracts"

import { DomainPill } from "~/components/dashboard/dashboard-status"
import { DocsDomainDeleteDialog } from "~/components/dashboard/docs-domain-delete-dialog"
import { DnsSetupGuide } from "~/components/dashboard/dns-setup-guide"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  getDocsDomainStatus,
  type DocsDomainStage,
} from "~/lib/dashboard/domain-status"
import { cn } from "~/lib/utils"

const ROUTING_CHECK_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

interface DocsDomainCardProps {
  domain: DocsDomainDto
  isChecking: boolean
  isDeleting: boolean
  onCheck: () => void
  onDelete: () => Promise<string | null>
  /** Hides Check again and Delete for a role without `domains.write`. */
  readOnly?: boolean
}

export function DocsDomainCard({
  domain,
  isChecking,
  isDeleting,
  onCheck,
  onDelete,
  readOnly = false,
}: DocsDomainCardProps) {
  const status = getDocsDomainStatus(domain)
  const canCheck = domain.kind === "custom_domain" && domain.status !== "disabled"
  const canDelete = domain.kind === "custom_domain"

  return (
    <article className="surface-card">
      <header className="grid gap-4 border-b border-divider p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <a
              href={`https://${domain.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex min-w-0 items-center gap-1.5 font-mono text-sm text-foreground underline-offset-4 hover:underline"
            >
              <span className="break-all">{domain.hostname}</span>
              <ExternalLink aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
            </a>
            <DomainPill label={domain.kind === "custom_domain" ? "custom" : "doxa"} />
            <DomainPill label={status.overall.label} tone={status.overall.tone} />
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {status.summary}
          </p>
        </div>

        {readOnly ? null : (
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCheck}
              disabled={!canCheck || isChecking || isDeleting}
            >
              {isChecking ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <RefreshCw aria-hidden="true" />
            )}
            {isChecking ? "Checking…" : "Check again"}
          </Button>
          <DocsDomainDeleteDialog
            hostname={domain.hostname}
            disabled={!canDelete || isChecking || isDeleting}
            isDeleting={isDeleting}
            onDelete={onDelete}
          />
        </div>
        )}
      </header>

      <div className="grid border-b border-divider sm:grid-cols-3">
        {status.stages.map((stage, index) => (
          <DomainStage key={stage.label} stage={stage} hasDivider={index > 0} />
        ))}
      </div>

      <DomainDetails domain={domain} />
    </article>
  )
}

function DomainStage({ stage, hasDivider }: { stage: DocsDomainStage; hasDivider: boolean }) {
  const Icon = stage.state === "ready" ? Check : stage.state === "failed" ? AlertCircle : CircleDashed

  return (
    <div className={cn(
      "flex items-start gap-3 px-4 py-3",
      hasDivider && "border-t border-divider sm:border-t-0 sm:border-l",
    )}>
      <span className={cn(
        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm border",
        stage.state === "ready" && "border-success/50 bg-success/10 text-success",
        stage.state === "failed" && "border-destructive/50 bg-destructive/10 text-destructive",
        stage.state === "checking" && "border-warning/50 bg-warning/10 text-warning",
      )}>
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="font-mono text-[10px] font-bold tracking-[0.14em] text-foreground uppercase">
          {stage.label}
        </p>
        <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">
          {stage.detail}
        </p>
      </div>
    </div>
  )
}

function DomainDetails({ domain }: { domain: DocsDomainDto }) {
  const needsDnsSetup = domain.kind === "custom_domain"
    && domain.verificationStatus !== "verified"
  const hasDetails = needsDnsSetup
    || domain.verificationError !== null
    || domain.routingError !== null
    || domain.routingCheckedAt !== null

  if (!hasDetails) return null

  return (
    <div className="flex flex-col gap-4 p-4">
      {needsDnsSetup ? (
        <DnsSetupDetails domain={domain} />
      ) : null}
      {domain.verificationError ? (
        <DomainError title="Hostname verification failed" message={domain.verificationError} />
      ) : null}
      {domain.routingError ? (
        <DomainError title="Delivery check failed" message={domain.routingError} />
      ) : null}

      {domain.routingCheckedAt ? (
        <p className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">
          Last delivery check{" "}
          <time dateTime={domain.routingCheckedAt}>
            {ROUTING_CHECK_DATE_FORMAT.format(new Date(domain.routingCheckedAt))}
          </time>
        </p>
      ) : null}
    </div>
  )
}

function DnsSetupDetails({ domain }: { domain: DocsDomainDto }) {
  const record = domain.dnsRecord

  return (
    <section aria-label="DNS setup" className="flex flex-col gap-2">
      <p className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">DNS setup</p>
      {record ? (
        <>
          <DnsSetupGuide domain={domain} record={record} />
          <div
            aria-label="Automatic certificate issuance"
            className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
          >
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <p>Doxa issues the SSL certificate automatically after the record works.</p>
          </div>
        </>
      ) : (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>DNS configuration unavailable</AlertTitle>
          <AlertDescription>
            Doxa cannot provide the CNAME target for this environment.
          </AlertDescription>
        </Alert>
      )}
    </section>
  )
}

function DomainError({ title, message }: { title: string; message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="break-words">{message}</AlertDescription>
    </Alert>
  )
}
