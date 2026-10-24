import type { Client } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { Harness } from "./harness";
import { RESOURCE_URL, workerRequest } from "./harness";

const toolErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    requestId: z.string(),
  }),
});

const structuredSchema = z.record(z.string(), z.unknown());

export interface ToolCallOutcome {
  isError: boolean;
  structured: Record<string, unknown>;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    structured: structuredSchema.parse(result.structuredContent ?? {}),
  };
}

export function toolError(outcome: ToolCallOutcome) {
  if (!outcome.isError) throw new Error("Expected a tool error.");
  return toolErrorSchema.parse(outcome.structured).error;
}

/** Per-request client capabilities that declare the MCP Tasks extension. */
export const TASKS_CLIENT_CAPABILITIES = {
  extensions: { "io.modelcontextprotocol/tasks": {} },
};

/** A 2026-07-28 request exactly as the SDK client sends it. */
export function modernRequest(
  method: string,
  name: string,
  params: Record<string, unknown>,
  clientCapabilities: Record<string, unknown> = {},
): Request {
  return workerRequest(RESOURCE_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-name": name,
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "doxa-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
        },
      },
    }),
  });
}

/** A 2026-07-28 tools/call exactly as the SDK client sends it. */
export function modernToolCallRequest(
  name: string,
  args: Record<string, unknown>,
  clientCapabilities: Record<string, unknown> = {},
): Request {
  return modernRequest("tools/call", name, { name, arguments: args }, clientCapabilities);
}

const rpcResponseSchema = z.union([
  z.object({ result: z.record(z.string(), z.unknown()) }),
  z.object({ error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }) }),
]);

export type RpcResponse = z.infer<typeof rpcResponseSchema>;

/** The JSON-RPC response of a JSON or a one-event SSE answer. */
export async function rpcResponse(response: Response): Promise<RpcResponse> {
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;
  return rpcResponseSchema.parse(JSON.parse(json));
}

export function rawToolCall(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return harness.fetch(modernToolCallRequest(name, args));
}
