import {
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { failureEntry } from "../logger";
import type { McpRequestContext } from "../request-context";
import { PlatformActionError } from "../services/platform-actions";
import type { ToolCost } from "../tool-definition";
import { approvalTask, taskSnapshot, type TaskSnapshot } from "./approval-task";
import { declaresTasks, TASKS_EXTENSION_CAPABILITY } from "./tasks-extension";

const taskIdParams = z.object({ taskId: z.uuid() });

/**
 * The `tasks/*` methods of SEP-2663 on a 2026-07-28 server. Every call reads
 * the approval row through doxa-api, which serves only the requests of the
 * calling client: that check is the task's auth binding.
 */
export function registerTaskHandlers(server: McpServer, context: McpRequestContext): void {
  const handle = taskHandler(context);
  server.server.setRequestHandler("tasks/get", { params: taskIdParams }, (params, ctx) =>
    handle("tasks/get", "read", ctx, async () =>
      approvalTask(await context.actions.getRequestTask(params.taskId), context.requestId),
    ),
  );
  // The SDK lifts `inputResponses` out of the params. Doxa ignores them: a
  // person decides in the dashboard, so the link is the only input.
  server.server.setRequestHandler("tasks/update", { params: taskIdParams }, (params, ctx) =>
    handle("tasks/update", "read", ctx, async () => {
      await context.actions.getRequest(params.taskId);
      return {};
    }),
  );
  server.server.setRequestHandler("tasks/cancel", { params: taskIdParams }, (params, ctx) =>
    handle("tasks/cancel", "write", ctx, () => cancel(context, params.taskId)),
  );
}

/**
 * Creates the task for a gated action call. Null when doxa-api cannot show
 * the request yet: the caller then returns the v1 result, which still works.
 */
export async function createApprovalTask(
  context: McpRequestContext,
  requestId: string,
): Promise<TaskSnapshot | null> {
  try {
    return taskSnapshot(approvalTask(await context.actions.getRequestTask(requestId), context.requestId));
  } catch (error) {
    context.logger.failure(
      failureEntry("mcp_task_create_failed", { requestId: context.requestId, tool: "tasks" }, error),
    );
    return null;
  }
}

type TaskMethod = "tasks/get" | "tasks/update" | "tasks/cancel";

function taskHandler(context: McpRequestContext) {
  return async <T>(method: TaskMethod, cost: ToolCost, ctx: ServerContext, work: () => Promise<T>): Promise<T> => {
    if (!declaresTasks(ctx.mcpReq.envelope)) {
      throw new MissingRequiredClientCapabilityError({ requiredCapabilities: TASKS_EXTENSION_CAPABILITY });
    }
    if (!(await context.limiter.allow(cost, context.actor))) {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "Rate limited. Retry after 60 seconds.");
    }
    try {
      return await work();
    } catch (error) {
      throw protocolErrorFor(context, method, error);
    }
  };
}

/** Cancellation is cooperative: a request that is no longer pending keeps its outcome. */
async function cancel(context: McpRequestContext, taskId: string): Promise<Record<string, never>> {
  try {
    await context.actions.cancelRequest(taskId);
  } catch (error) {
    if (!(error instanceof PlatformActionError && error.code === "request_not_pending")) throw error;
  }
  return {};
}

function protocolErrorFor(context: McpRequestContext, method: TaskMethod, error: unknown): ProtocolError {
  if (error instanceof PlatformActionError && error.code === "request_not_found") {
    return new ProtocolError(ProtocolErrorCode.InvalidParams, "Failed to retrieve task: Task not found");
  }
  context.logger.failure(failureEntry("mcp_task_internal_error", { requestId: context.requestId, tool: method }, error));
  return new ProtocolError(ProtocolErrorCode.InternalError, `Internal error. Request ID: ${context.requestId}`);
}
