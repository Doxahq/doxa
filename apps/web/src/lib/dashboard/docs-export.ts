import type { DocsExportStatus } from "@doxahq/contracts/docs-export"

import { formatLimitValue } from "~/lib/dashboard/billing-model"

/** The quota line of the export card: "Your plan allows one export every 24 hours." */
export function exportQuotaText(status: DocsExportStatus): string | null {
  const hours = status.quota.windowHours
  if (hours === null) return null
  if (hours === 24) return "Your plan allows one export every 24 hours."
  if (hours === 1) return "Your plan allows one export an hour."
  return `Your plan allows one export every ${hours} hours.`
}

/** Why the export cannot run now, or null when it can. */
export function exportBlockedText(status: DocsExportStatus, now: Date = new Date()): string | null {
  switch (status.reason) {
    case null:
      return null
    case "no_published_version":
      return "Publish the docs first. The export holds the published version."
    case "too_large":
      return `The docs are larger than ${formatLimitValue("docs.storage_bytes", status.maxBytes)}, the limit for one export.`
    case "quota_spent": {
      const at = status.quota.resetsAt ? new Date(status.quota.resetsAt) : null
      return at ? `You can export again ${formatNextExport(at, now)}.` : "You can export again later."
    }
  }
}

function formatNextExport(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const sameDay = at.toDateString() === now.toDateString()
  if (sameDay) return `at ${time}`
  const date = at.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  return `on ${date} at ${time}`
}

const REDIRECT_ERRORS: Record<string, string> = {
  no_published_version: "Publish the docs first. The export holds the published version.",
  export_too_large: "The docs are too large to export as one archive.",
  export_in_progress: "An export of this project is already running. Try again in a moment.",
  export_limit: "You used the export of your plan for now. The card shows when you can export again.",
  export_unavailable: "Export is not available right now. Try again in a few minutes.",
}

/**
 * The message for the `export_error` code that the API puts on the settings
 * URL when a download link fails. Only known codes, never the raw value.
 */
export function exportRedirectErrorText(code: string | null): string | null {
  if (!code) return null
  return Object.hasOwn(REDIRECT_ERRORS, code) ? (REDIRECT_ERRORS[code] ?? null) : "The export did not start. Try again."
}

interface WaitForExportClaimOptions {
  readonly attempts?: number
  readonly delayMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * After a download starts, reads the export status again until the API shows
 * the spent quota, so the button never looks ready while the export runs. A
 * plan without a quota stays available: then it stops after the last attempt.
 * A failed read stops at once and returns null.
 */
export async function waitForExportClaim(
  readStatus: () => Promise<DocsExportStatus>,
  { attempts = 10, delayMs = 750, sleep = defaultSleep }: WaitForExportClaimOptions = {},
): Promise<DocsExportStatus | null> {
  let last: DocsExportStatus | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(delayMs)
    try {
      last = await readStatus()
    } catch {
      return null
    }
    if (!last.available) return last
  }
  return last
}
