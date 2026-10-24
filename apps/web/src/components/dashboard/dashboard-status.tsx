import type { ComponentProps } from "react"
import type { GenerationJobDto } from "@doxahq/contracts"

import { Badge } from "~/components/ui/badge"

type BadgeVariant = ComponentProps<typeof Badge>["variant"]
export type DomainPillTone = "muted" | "success" | "warning" | "danger"

export function JobStatusBadge({ status }: { status: GenerationJobDto["status"] }) {
  return (
    <Badge variant={getJobStatusBadgeVariant(status)}>
      {status}
    </Badge>
  )
}

export function DomainPill({
  label,
  tone = "muted",
}: {
  label: string
  tone?: DomainPillTone
}) {
  return (
    <Badge variant={getDomainPillVariant(tone)}>
      {label.replace(/_/g, " ")}
    </Badge>
  )
}

export function getJobStatusBadgeVariant(status: GenerationJobDto["status"]): BadgeVariant {
  if (status === "succeeded") return "success"
  if (status === "failed") return "destructive"
  if (status === "cancelled") return "warning"
  if (status === "queued") return "muted"
  return "outline"
}

export function getDomainPillVariant(tone: DomainPillTone): BadgeVariant {
  if (tone === "success") return "success"
  if (tone === "warning") return "warning"
  if (tone === "danger") return "destructive"
  return "muted"
}
