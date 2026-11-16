import { Badge } from "~/components/ui/badge"
import type { StatusTone } from "~/lib/dashboard/billing-model"

const TONE_VARIANT = {
  success: "success",
  warning: "warning",
  danger: "danger",
  muted: "muted",
} as const satisfies Record<StatusTone, "success" | "warning" | "danger" | "muted">

/** A status tag: never hoverable, it does nothing on click. */
export function BillingStatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return <Badge variant={TONE_VARIANT[tone]}>{label}</Badge>
}

/** A square meter bar (the dashboard has no rounded progress). */
export function MeterBar({ percent, tone = "primary", label }: { percent: number; tone?: "primary" | "warning"; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="h-1.5 w-full overflow-hidden bg-muted"
    >
      <div className={tone === "warning" ? "h-full bg-warning" : "h-full bg-primary"} style={{ width: `${clamped}%` }} />
    </div>
  )
}
