import type {
  AgentActivityOutcome,
  AgentActivityRecord,
} from "@doxahq/api/repositories/agent-activity";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import type { ToolErrorCode } from "./errors";
import type { ToolCost } from "./tool-definition";
import type { AgentActionKind } from "@doxahq/contracts/approval-requests";

const DENIAL_CODES: ReadonlySet<ToolErrorCode> = new Set([
  "not_found",
  "scope_missing",
  "project_not_in_grant",
  "forbidden",
  "insufficient_scope",
]);

/** Reads go to the Worker logs only (spec 11.2). */
export function recordsActivity(cost: ToolCost): boolean {
  return cost !== "read";
}

export function outcomeFor(
  errorCode: ToolErrorCode | null,
  action: ActionFacts | null = null,
): AgentActivityOutcome {
  if (errorCode === null) return action?.pendingRequestId ? "approval_required" : "succeeded";
  if (errorCode === "rate_limited") return "rate_limited";
  return DENIAL_CODES.has(errorCode) ? "denied" : "failed";
}

/** What an action tool's result says about the action (spec 9.8). */
export interface ActionFacts {
  kind: AgentActionKind;
  /** Set when the policy required approval and a request now waits. */
  pendingRequestId: string | null;
}

export interface ToolCallSummary {
  tool: string;
  projectId: string | null;
  errorCode: ToolErrorCode | null;
  durationMs: number;
  action: ActionFacts | null;
}

/** Pure: reads the action facts from a successful action tool output. */
export function actionFactsFor(
  kind: AgentActionKind | undefined,
  output: Record<string, unknown> | null,
): ActionFacts | null {
  if (kind === undefined) return null;
  const request = output?.["request"];
  const pendingRequestId =
    output?.["outcome"] === "approval_required" && isRecord(request) && typeof request["id"] === "string"
      ? request["id"]
      : null;
  return { kind, pendingRequestId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function activityRecordFor(
  actor: AgentActor,
  call: ToolCallSummary,
  inputSha256: string,
): AgentActivityRecord {
  const { channel } = actor;
  return {
    userId: actor.principal.userId,
    clientId: channel.clientId,
    clientName: channel.clientName,
    grantRef: channel.grantRef,
    projectId: call.projectId,
    tool: call.tool,
    actionKind: call.action?.kind ?? null,
    approvalRequestId: call.action?.pendingRequestId ?? null,
    outcome: outcomeFor(call.errorCode, call.action),
    errorCode: call.errorCode,
    policySource: null,
    durationMs: call.durationMs,
    inputSha256,
  };
}

export async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value) ?? "");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
