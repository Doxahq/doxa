import { Fragment, useId, type CSSProperties } from "react"
import { ExternalLink, Globe, LoaderCircle } from "lucide-react"
import type { DnsHostProvider, DocsDomainDnsRecord, DocsDomainDto } from "@doxahq/contracts"

import { DnsRecordFields, type DnsRecordFieldValue } from "~/components/dashboard/dns-record-fields"
import { TextBar } from "~/components/dashboard/skeletons/skeleton-kit"
import { Button } from "~/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select"
import { DNS_HOST_BRANDS } from "~/lib/dashboard/dns-host-brands"
import {
  DNS_SETUP_GUIDE_IDS,
  getDnsHostName,
  getDnsRecordNameValue,
  getDnsSetupGuideLabel,
  isDnsSetupGuideId,
  type DnsSetupGuide,
  type DnsSetupGuideId,
  type DnsSetupTextPart,
} from "~/lib/dashboard/dns-setup-guides"
import { useDnsSetupGuide, type DnsSetupGuideState } from "~/lib/dashboard/use-dns-setup-guide"
import { cn } from "~/lib/utils"

const PANEL_CLASS = "overflow-hidden rounded-md border border-border"
const HEADER_CLASS = "flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5"
const STEP_LIST_CLASS = "flex list-decimal flex-col gap-2.5 py-3 pr-3 pl-8 text-sm leading-6 text-muted-foreground marker:font-mono marker:text-xs"

interface DnsSetupGuideProps {
  domain: Pick<DocsDomainDto, "id" | "projectId" | "hostname">
  record: DocsDomainDnsRecord
}

/**
 * Steps to add the CNAME record at the domain's DNS host, branded for the
 * detected host. It looks up the host only when it mounts, so a domain
 * without a CNAME target never triggers a lookup.
 */
export function DnsSetupGuide({ domain, record }: DnsSetupGuideProps) {
  return <DnsSetupGuidePanel state={useDnsSetupGuide(domain)} hostname={domain.hostname} record={record} />
}

/** The steps for one guide state. The record values show at once; only the host part waits for the lookup. */
export function DnsSetupGuidePanel({
  state,
  hostname,
  record,
}: {
  state: DnsSetupGuideState
  hostname: string
  record: DocsDomainDnsRecord
}) {
  if (state.status === "detecting") {
    return (
      <div aria-busy="true" aria-label="Detecting your DNS host" className={PANEL_CLASS}>
        <div className={HEADER_CLASS}>
          <DetectingHost hostname={hostname} />
        </div>
        <ol className={STEP_LIST_CLASS}>
          <li><TextBar width="70%" className="text-sm leading-6" /></li>
          <RecordStep fields={recordFields(hostname, null, record)} />
          <li><TextBar width="55%" className="text-sm leading-6" /></li>
        </ol>
      </div>
    )
  }

  const { detected, guide, choose, nameservers, zone } = state
  const showsDetectedHost = detected !== null && guide.id === detected

  return (
    <section aria-label="Setup steps" className={PANEL_CLASS}>
      <div className={HEADER_CLASS} style={brandTint(guide.id)}>
        {showsDetectedHost ? (
          <DetectedHost provider={detected} onReject={() => choose("other")} />
        ) : (
          <HostPicker value={guide.id} detected={detected} onChange={choose} />
        )}
      </div>
      {detected === null && nameservers.length > 0 && guide.id === "other" ? (
        <p className="border-b border-border px-3 py-2 text-xs leading-5 text-muted-foreground">
          Your nameservers:{" "}
          <span className="font-mono break-all text-foreground">{nameservers.join(", ")}</span>
        </p>
      ) : null}
      <GuideSteps guide={guide} fields={recordFields(hostname, zone, record)} />
    </section>
  )
}

/** The header while the lookup runs: a spinner and what Doxa is doing, in the place of the host. */
function DetectingHost({ hostname }: { hostname: string }) {
  return (
    <div role="status" className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background"
      >
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </span>
      <p className="min-w-0 text-sm leading-5 text-foreground">
        <span className="block font-medium">Detecting your DNS host…</span>
        <span className="block text-xs break-all text-muted-foreground">
          Reading the nameservers for {hostname}
        </span>
      </p>
    </div>
  )
}

function DetectedHost({ provider, onReject }: { provider: DnsHostProvider; onReject: () => void }) {
  const name = getDnsHostName(provider)

  return (
    <>
      <div className="flex min-w-0 items-center gap-2.5">
        <DnsHostLogo id={provider} className="size-8" />
        <p className="min-w-0 text-sm leading-5 text-foreground">
          <span className="block font-medium">Your DNS is on {name}</span>
          <span className="block text-xs text-muted-foreground">Detected from your nameservers</span>
        </p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onReject}>
        Not using {name}?
      </Button>
    </>
  )
}

function HostPicker({
  value,
  detected,
  onChange,
}: {
  value: DnsSetupGuideId
  detected: DnsHostProvider | null
  onChange: (id: DnsSetupGuideId) => void
}) {
  const labelId = useId()

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <DnsHostLogo id={value} className="size-8" />
      <span id={labelId} className="text-sm text-foreground">
        DNS host
      </span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (isDnsSetupGuideId(next)) onChange(next)
        }}
      >
        <SelectTrigger className="h-8 w-56" aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DNS_SETUP_GUIDE_IDS.map((id) => (
            <SelectItem key={id} value={id}>
              <span className="flex items-center gap-2">
                <DnsHostMark id={id} className="size-3.5" />
                {getDnsSetupGuideLabel(id)}
                {id === detected ? " (detected)" : ""}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function GuideSteps({ guide, fields }: { guide: DnsSetupGuide; fields: readonly DnsRecordFieldValue[] }) {
  return (
    <>
      <ol className={STEP_LIST_CLASS}>
        {guide.steps.map((step) =>
          step.kind === "record" ? (
            <RecordStep key={step.id} fields={fields} />
          ) : (
            <li key={step.id}>
              <StepText parts={step.parts} />
            </li>
          ),
        )}
      </ol>
      {guide.helpUrl && guide.hostName ? (
        <a
          href={guide.helpUrl}
          target="_blank"
          rel="noreferrer"
          className="mx-3 mb-3 inline-flex w-fit items-center gap-1.5 text-xs text-primary-text underline-offset-4 hover:underline"
        >
          {guide.hostName} help
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ) : null}
    </>
  )
}

function RecordStep({ fields }: { fields: readonly DnsRecordFieldValue[] }) {
  return (
    <li>
      Add this record:
      <div className="mt-2">
        <DnsRecordFields fields={fields} />
      </div>
    </li>
  )
}

function recordFields(hostname: string, zone: string | null, record: DocsDomainDnsRecord): DnsRecordFieldValue[] {
  return [
    { label: "Type", value: record.type },
    { label: "Name", value: getDnsRecordNameValue(hostname, zone), copyLabel: "DNS name" },
    { label: "Target", value: record.target, copyLabel: "DNS target" },
  ]
}

function StepText({ parts }: { parts: readonly DnsSetupTextPart[] }) {
  // Parts are fixed per step and never reorder, so the index is a stable key.
  return parts.map((part, index) => (
    <Fragment key={index}>
      {typeof part === "string" ? (
        part
      ) : (
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs break-all text-foreground">
          {part.code}
        </code>
      )}
    </Fragment>
  ))
}

/** The host's mark on a tile tinted with its brand color. */
function DnsHostLogo({ id, className }: { id: DnsSetupGuideId; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("flex shrink-0 items-center justify-center rounded-md border border-border bg-background", className)}
    >
      <DnsHostMark id={id} className="size-[62%]" />
    </span>
  )
}

/** The host's brand mark in its brand color, or a globe for any other host. */
function DnsHostMark({ id, className }: { id: DnsSetupGuideId; className?: string }) {
  if (id === "other") {
    return <Globe aria-hidden="true" className={cn("shrink-0 text-muted-foreground", className)} />
  }
  const brand = DNS_HOST_BRANDS[id]
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("shrink-0", brand.color === null && "text-foreground", className)}
      fill={brand.color ?? "currentColor"}
    >
      <path d={brand.path} />
    </svg>
  )
}

/** A faint wash of the brand color behind the header. A host with a black mark gets none. */
function brandTint(id: DnsSetupGuideId): CSSProperties | undefined {
  if (id === "other") return undefined
  const color = DNS_HOST_BRANDS[id].color
  return color ? { backgroundColor: `color-mix(in oklab, ${color} 9%, transparent)` } : undefined
}
