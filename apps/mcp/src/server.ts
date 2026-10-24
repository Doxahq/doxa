import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { version } from "../package.json";
import { DOXA_SERVER_INSTRUCTIONS } from "./instructions";
import type { McpRequestContext } from "./request-context";
import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { scopeChallengeFor } from "./scope-challenge";
import { declaresTasks, TASKS_EXTENSION_CAPABILITY } from "./tasks/tasks-extension";
import { registerTaskHandlers } from "./tasks/task-handlers";
import type { AnyMcpTool } from "./tool-definition";
import { runTool, type ToolCallProtocol } from "./tool-runner";
import { TOOLS } from "./tools";

export const DOXA_SERVER_INFO = { name: "doxa", version };

/**
 * `modern` serves the 2026-07-28 protocol, `legacy` the 2025 protocol. Only
 * modern servers send per-tool scope challenges and tasks: 2025 clients keep
 * the v1 behavior (a tool error for a missing scope, approval polling).
 */
export type ProtocolEra = "modern" | "legacy";

/** A new server for each request: the closure carries the request's context. */
export function createDoxaMcpServer(context: McpRequestContext, era: ProtocolEra): McpServer {
  const modern = era === "modern";
  const server = new McpServer(DOXA_SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      ...(modern ? TASKS_EXTENSION_CAPABILITY : {}),
    },
    instructions: DOXA_SERVER_INSTRUCTIONS,
  });
  registerTools(server, TOOLS, context, era);
  registerResources(server, context);
  registerPrompts(server);
  if (modern) registerTaskHandlers(server, context);
  return server;
}

export function registerTools(
  server: McpServer,
  tools: readonly AnyMcpTool[],
  context: McpRequestContext,
  era: ProtocolEra,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: { title: tool.title, ...tool.annotations },
        ...(era === "modern" && tool.scope !== null ? { scopeChallenge: scopeChallengeFor(tool.scope) } : {}),
      },
      (input, ctx) => runTool(tool, context, input, callProtocolOf(ctx)),
    );
  }
}

function callProtocolOf(ctx: ServerContext): ToolCallProtocol {
  return { tasks: declaresTasks(ctx.mcpReq.envelope) };
}
