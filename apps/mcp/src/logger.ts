import type { AgentActivityOutcome } from "@doxahq/api/repositories/agent-activity";
import type { ToolErrorCode } from "./errors";

/**
 * One line for each tool call (spec 16). Never add tokens, grant props, page
 * content, or site config content to these entries.
 */
export interface ToolCallLogEntry {
  requestId: string;
  tool: string;
  userId: string;
  clientId: string;
  projectId: string | null;
  outcome: AgentActivityOutcome;
  errorCode: ToolErrorCode | null;
  durationMs: number;
  policySource: string | null;
}

export interface McpFailureLogEntry {
  event:
    | "mcp_tool_internal_error"
    | "mcp_activity_write_failed"
    | "mcp_live_event_write_failed"
    | "mcp_task_create_failed"
    | "mcp_task_internal_error";
  requestId: string;
  tool: string;
  errorName: string;
  stack: string | null;
}

export interface McpLogger {
  toolCall(entry: ToolCallLogEntry): void;
  failure(entry: McpFailureLogEntry): void;
}

export const consoleMcpLogger: McpLogger = {
  toolCall: (entry) =>
    console.log(JSON.stringify({ event: "mcp_tool_call", ...entry })),
  failure: (entry) => console.error(JSON.stringify(entry)),
};

export function failureEntry(
  event: McpFailureLogEntry["event"],
  context: { requestId: string; tool: string },
  error: unknown,
): McpFailureLogEntry {
  return {
    event,
    ...context,
    errorName: error instanceof Error ? error.name : "UnknownError",
    stack: error instanceof Error ? (error.stack ?? null) : null,
  };
}
