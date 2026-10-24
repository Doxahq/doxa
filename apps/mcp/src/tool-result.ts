import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolErrorBody } from "./errors";
import type { TaskSnapshot } from "./tasks/approval-task";

/** The text block repeats the structured content for clients that ignore it. */
export function toolSuccess(
  structured: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

export function toolFailure(error: ToolErrorBody): CallToolResult {
  const structured = { error };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * A SEP-2663 `CreateTaskResult` (`resultType: "task"`). It keeps the v1
 * content and structured content: the SDK checks them against the tool's
 * output schema, and Tasks clients ignore the extra fields.
 */
export function toolTask(
  structured: Record<string, unknown>,
  task: TaskSnapshot,
): CallToolResult & TaskSnapshot & { resultType: "task" } {
  return { ...toolSuccess(structured), ...task, resultType: "task" };
}
