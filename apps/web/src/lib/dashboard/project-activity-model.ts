import type { AgentActionKind } from "@doxahq/contracts/approval-requests"
import type { ProjectActivityActor, ProjectActivityEvent } from "@doxahq/contracts/project-overview"

export type ActivityFilter = "all" | ProjectActivityActor["kind"]

export const ACTIVITY_FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "doxabot", label: "Doxabot" },
  { id: "person", label: "People" },
  { id: "agent", label: "Agents" },
]

export function filterActivity(
  events: readonly ProjectActivityEvent[],
  filter: ActivityFilter,
): ProjectActivityEvent[] {
  return events.filter((event) => filter === "all" || event.actor.kind === filter)
}

const AGENT_ACTION_TEXT: Record<AgentActionKind, string> = {
  "docs.publish": "published the docs",
  "docs.restore": "restored a version",
  "domain.add": "added a domain",
  "domain.remove": "removed a domain",
  "domain.check": "checked a domain",
  "project.create": "created this project",
  "project.delete": "deleted a project",
  "generation.start": "started a generation",
  "generation.cancel": "cancelled a generation",
}

export interface ActivityDescription {
  /** The words after the actor's name. */
  what: string
  detail: string | null
}

function changedPagesText(count: number | null): string | null {
  if (!count) return null
  return count === 1 ? "1 page updated" : `${count} pages updated`
}

export function describeActivityEvent(event: ProjectActivityEvent): ActivityDescription {
  switch (event.type) {
    case "published":
      return {
        what:
          event.publicationKind === "restore"
            ? `restored version ${event.versionNumber}`
            : `published version ${event.versionNumber}`,
        detail: changedPagesText(event.changedPageCount),
      }
    case "generation_staged":
      return { what: "finished a generation for review", detail: null }
    case "generation_failed":
      return { what: "could not finish a generation", detail: null }
    case "generation_cancelled":
      return { what: "cancelled a generation", detail: null }
    case "preview_built":
      return { what: `built a preview for pull request #${event.pullRequestNumber}`, detail: null }
    case "agent_action":
      return { what: AGENT_ACTION_TEXT[event.actionKind], detail: "Through the MCP server" }
  }
}
