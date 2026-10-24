import type { SiteSettingsSaveStatus } from "~/lib/dashboard/use-site-settings"
import { cn } from "~/lib/utils"

/** Where the site settings stand: saving, saved, blocked by errors, or failed. */
export function SiteSettingsSaveStatus({
  status,
  className,
}: {
  status: SiteSettingsSaveStatus
  className?: string
}) {
  const [text, tone] = describeSaveStatus(status)
  return (
    <p role="status" aria-live="polite" className={cn("text-sm", tone, className)}>
      {text}
    </p>
  )
}

function describeSaveStatus(status: SiteSettingsSaveStatus): [string, string] {
  switch (status.kind) {
    case "saving":
      return ["Saving…", "text-muted-foreground"]
    case "pending":
      return ["Unsaved changes", "text-muted-foreground"]
    case "saved":
      return ["Saved as unpublished changes", "text-success"]
    case "blocked":
      return [
        `Not saved: correct ${status.errorCount} error${status.errorCount === 1 ? "" : "s"} to save.`,
        "text-danger",
      ]
    case "failed":
      return [status.message, "text-danger"]
    case "idle":
      return ["Same as the published settings", "text-muted-foreground"]
  }
}
