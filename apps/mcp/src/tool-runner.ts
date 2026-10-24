import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  actionFactsFor,
  activityRecordFor,
  outcomeFor,
  recordsActivity,
  sha256Hex,
  type ToolCallSummary,
} from "./activity";
import {
  mapToolError,
  MissingToolScopeError,
  ToolRateLimitedError,
  type ToolErrorBody,
} from "./errors";
import { failureEntry } from "./logger";
import { createToolContext, type McpRequestContext } from "./request-context";
import { createApprovalTask } from "./tasks/task-handlers";
import type { AnyMcpTool } from "./tool-definition";
import { toolFailure, toolSuccess, toolTask } from "./tool-result";

export type ToolInput = Record<string, unknown>;

/** What the client declared on this `tools/call`. */
export interface ToolCallProtocol {
  /** The request declares the MCP Tasks extension (2026-07-28 only). */
  readonly tasks: boolean;
}

export const PLAIN_TOOL_CALL: ToolCallProtocol = { tasks: false };

type ToolRun =
  | { kind: "succeeded"; output: Record<string, unknown> }
  | { kind: "failed"; error: ToolErrorBody; cause: unknown };

/**
 * Spec 9.5: scope, rate limit, run, output check, then log and audit. The SDK
 * has already parsed the input against the tool's input schema.
 */
export async function runTool(
  tool: AnyMcpTool,
  context: McpRequestContext,
  input: ToolInput,
  call: ToolCallProtocol = PLAIN_TOOL_CALL,
): Promise<CallToolResult> {
  const startedAt = context.now();
  const run = await settle(tool, context, input);
  const summary: ToolCallSummary = {
    tool: tool.name,
    projectId: readProjectId(input),
    errorCode: run.kind === "failed" ? run.error.code : null,
    durationMs: Math.max(0, context.now() - startedAt),
    action: actionFactsFor(tool.action, run.kind === "succeeded" ? run.output : null),
  };
  report(tool, context, summary, input, run);
  return run.kind === "succeeded"
    ? present(tool, context, run.output, call)
    : toolFailure(run.error);
}

/**
 * Spec v2 §9: a gated action becomes a task for a Tasks client. Every other
 * client, and every other result, gets the v1 result.
 */
async function present(
  tool: AnyMcpTool,
  context: McpRequestContext,
  output: Record<string, unknown>,
  call: ToolCallProtocol,
): Promise<CallToolResult> {
  const pendingRequestId = call.tasks ? (tool.pendingRequestOf?.(output) ?? null) : null;
  if (pendingRequestId === null) return toolSuccess(output);
  const task = await createApprovalTask(context, pendingRequestId);
  return task === null ? toolSuccess(output) : toolTask(output, task);
}

async function settle(
  tool: AnyMcpTool,
  context: McpRequestContext,
  input: ToolInput,
): Promise<ToolRun> {
  try {
    return { kind: "succeeded", output: await execute(tool, context, input) };
  } catch (cause) {
    return {
      kind: "failed",
      error: mapToolError(cause, context.requestId),
      cause,
    };
  }
}

async function execute(
  tool: AnyMcpTool,
  context: McpRequestContext,
  input: ToolInput,
): Promise<Record<string, unknown>> {
  // Mandatory: the SDK scope challenge runs only for 2026 clients, so this
  // is the check that 2025 clients see, as a tool error.
  if (tool.scope !== null && !context.actor.channel.scopes.has(tool.scope)) {
    throw new MissingToolScopeError(tool.scope);
  }
  if (!(await context.limiter.allow(tool.cost, context.actor))) {
    throw new ToolRateLimitedError();
  }
  const output = tool.output.parse(
    await tool.run(createToolContext(context), input),
  );
  if (!isRecord(output)) {
    throw new TypeError(`Tool ${tool.name} returned a non-object result.`);
  }
  return output;
}

function report(
  tool: AnyMcpTool,
  context: McpRequestContext,
  summary: ToolCallSummary,
  input: ToolInput,
  run: ToolRun,
): void {
  const { actor, logger, requestId } = context;
  if (run.kind === "failed" && run.error.code === "internal_error") {
    logger.failure(
      failureEntry(
        "mcp_tool_internal_error",
        { requestId, tool: tool.name },
        run.cause,
      ),
    );
  }
  logger.toolCall({
    requestId,
    tool: tool.name,
    userId: actor.principal.userId,
    clientId: actor.channel.clientId,
    projectId: summary.projectId,
    outcome: outcomeFor(summary.errorCode, summary.action),
    errorCode: summary.errorCode,
    durationMs: summary.durationMs,
    policySource: null,
  });
  if (recordsActivity(tool.cost)) {
    context.waitUntil(writeActivity(context, summary, input));
  }
}

async function writeActivity(
  context: McpRequestContext,
  summary: ToolCallSummary,
  input: ToolInput,
): Promise<void> {
  try {
    const record = activityRecordFor(
      context.actor,
      summary,
      await sha256Hex(input),
    );
    await context.activity.append(record);
  } catch (error) {
    context.logger.failure(
      failureEntry(
        "mcp_activity_write_failed",
        { requestId: context.requestId, tool: summary.tool },
        error,
      ),
    );
  }
}

function readProjectId(input: ToolInput): string | null {
  const value = input["projectId"];
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
