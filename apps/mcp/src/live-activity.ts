import type { NewAgentLiveEvent } from "@doxahq/api/repositories/agent-live-events";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import type { DocsPageChange } from "@doxahq/api/services/docs-content/page-changes";
import { cleanAgentText } from "@doxahq/contracts/agent-live-activity";
import type { ToolActivity } from "./tool-definition";

/** "main" is not a stored branch, so its events have no branch ID. */
export function liveBranchId(branch: string | undefined): string | null {
  return branch === undefined || branch === "main" ? null : branch;
}

/** The agent chose this text, so it is cleaned before it is stored. */
export function liveEventFor(
  actor: AgentActor,
  tool: string,
  activity: ToolActivity,
  change: DocsPageChange | null = null,
): NewAgentLiveEvent {
  const { channel } = actor;
  return {
    branchId: activity.branchId ?? null,
    userId: actor.principal.userId,
    grantRef: channel.grantRef,
    clientId: channel.clientId,
    clientName: cleanAgentText(channel.clientName) ?? "Unnamed agent",
    tool,
    kind: activity.kind,
    pageHref: cleanAgentText(activity.pageHref, 500),
    pageTitle: cleanAgentText(activity.pageTitle),
    detail: cleanAgentText(activity.detail),
    note: cleanAgentText(activity.note),
    branchRevision: activity.branchRevision ?? null,
    linesAdded: change?.linesAdded ?? null,
    linesRemoved: change?.linesRemoved ?? null,
    diff: change?.diff ?? null,
  };
}
