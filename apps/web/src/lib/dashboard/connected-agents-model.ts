import type { ProjectScopeClaim } from "@doxahq/contracts/agent-access"

const GRANT_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
}

/** "All projects" or "3 projects" for a connected agent's project scope. */
export function formatGrantProjectScope(scope: ProjectScopeClaim): string {
  if (scope.kind === "all") return "All projects"
  const count = scope.projectIds.length
  return count === 1 ? "1 project" : `${count} projects`
}

/** A grant date such as "Oct 4, 2026", or "—" when there is none. */
export function formatGrantDate(value: string | null, locale?: string): string {
  if (value === null) return "—"
  return new Intl.DateTimeFormat(locale, GRANT_DATE_FORMAT).format(new Date(value))
}
