import { AlertTriangle } from "lucide-react"

/** Shown under free text that asks for more than style or content. Doxabot leaves that text out. */
export function FlaggedTextNotice({ subject }: { subject: "rule" | "context" }) {
  return (
    <div role="note" className="flex gap-2.5 border border-warning/35 bg-warning/8 px-3 py-2.5 text-[13px] leading-5">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>
        <span className="font-medium text-warning">This {subject} asks for more than style or content.</span>{" "}
        <span className="text-muted-foreground">Doxabot leaves it out.</span>
      </p>
    </div>
  )
}
