import { docsPublicationSummarySchema } from "@doxahq/contracts/docs-branches";
import { isAgentActionKind } from "@doxahq/contracts/approval-requests";
import type {
  ProjectActivityActor,
  ProjectActivityEvent,
  ProjectOverview,
} from "@doxahq/contracts/project-overview";
import type {
  AgentActionRow,
  FinishedJobRow,
  ProjectOverviewRows,
  PublicationRow,
} from "../repositories/project-overview";

/** How many events the Overview shows. */
export const PROJECT_ACTIVITY_LIMIT = 20;

const DOXABOT: ProjectActivityActor = { kind: "doxabot", name: "Doxabot" };

function publicationActor(row: PublicationRow): ProjectActivityActor {
  if (row.agentClientName) return { kind: "agent", name: row.agentClientName };
  if (row.actorName) return { kind: "person", name: row.actorName };
  return DOXABOT;
}

function changedPageCount(summary: unknown): number | null {
  const parsed = docsPublicationSummarySchema.safeParse(summary);
  return parsed.success ? (parsed.data.changedPageCount ?? null) : null;
}

/** The starter pages come with the project, so nobody did anything. */
function publicationEvent(row: PublicationRow): ProjectActivityEvent | null {
  if (row.kind === "starter") return null;
  return {
    id: `publication:${row.id}`,
    type: "published",
    occurredAt: row.createdAt.toISOString(),
    actor: publicationActor(row),
    publicationKind: row.kind,
    versionNumber: row.versionNumber,
    changedPageCount: changedPageCount(row.summary),
  };
}

/**
 * A production run that published has its publication in the feed already, so
 * it adds an event only while its version waits for review.
 */
function jobEvent(
  row: FinishedJobRow,
  cancelledBy: ReadonlyMap<string, string>,
): ProjectActivityEvent | null {
  const base = {
    id: `generation:${row.id}`,
    occurredAt: row.updatedAt.toISOString(),
    generationId: row.id,
  };

  if (row.status === "failed") {
    return { ...base, type: "generation_failed", actor: DOXABOT };
  }
  if (row.status === "cancelled") {
    const name = cancelledBy.get(row.id);
    return {
      ...base,
      type: "generation_cancelled",
      actor: name ? { kind: "person", name } : DOXABOT,
    };
  }
  if (row.publicationMode === "preview") {
    return row.pullRequestNumber === null
      ? null
      : {
          ...base,
          type: "preview_built",
          actor: DOXABOT,
          pullRequestNumber: row.pullRequestNumber,
        };
  }
  return row.versionStatus === "staged"
    ? { ...base, type: "generation_staged", actor: DOXABOT }
    : null;
}

/** A row whose action a release removed stays out of the feed. */
function agentActionEvent(row: AgentActionRow): ProjectActivityEvent | null {
  if (!row.actionKind || !isAgentActionKind(row.actionKind)) return null;
  return {
    id: `agent:${row.id}`,
    type: "agent_action",
    occurredAt: row.occurredAt.toISOString(),
    actor: { kind: "agent", name: row.clientName },
    actionKind: row.actionKind,
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

/** Newest first, then by id, so equal times keep one order between reads. */
function mergeActivity(
  rows: ProjectOverviewRows,
): ProjectActivityEvent[] {
  return [
    ...rows.publications.map(publicationEvent),
    ...rows.finishedJobs.map((row) => jobEvent(row, rows.cancelledBy)),
    ...rows.agentActions.map(agentActionEvent),
  ]
    .filter(isPresent)
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
    )
    .slice(0, PROJECT_ACTIVITY_LIMIT);
}

export function buildProjectOverview(
  rows: ProjectOverviewRows,
  toPreviewUrl: (hostname: string) => string,
): ProjectOverview {
  const latest = rows.publications[0] ?? null;
  return {
    latestPublication: latest && {
      kind: latest.kind,
      versionNumber: latest.versionNumber,
      publishedAt: latest.createdAt.toISOString(),
      actor: publicationActor(latest),
    },
    lastSyncedRevision: rows.lastSyncedRevision,
    activity: mergeActivity(rows),
    openPreviews: rows.openPreviews.map((row) => ({
      pullRequestNumber: row.pullRequestNumber,
      status: row.status,
      previewUrl: row.hostname ? toPreviewUrl(row.hostname) : null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}
