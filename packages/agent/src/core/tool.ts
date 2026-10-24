/**
 * Core Agent Library — Tool System
 * Define tools with Zod-validated parameters, convert to OpenAI format, and execute.
 */

import { z } from "zod/v4";
import { toolDefinition, type ServerTool } from "@tanstack/ai";
import type {
  AgentSpanCallback,
  ToolSpec,
  ToolDefinition,
  ToolExecutionContext,
} from "./types";
import { emitAgentSpan } from "./span";

/**
 * Define a tool with Zod-validated parameters.
 */
export function defineTool<T extends z.ZodType>(spec: ToolSpec<T>): ToolSpec<T> {
  return spec;
}

export interface TanStackToolOptions {
  limitOutput?: (output: string) => string;
  onSpan?: AgentSpanCallback;
}

/**
 * Convert Doxa tool specs to TanStack AI beta server tools.
 */
export function toTanStackServerTools(
  tools: ToolSpec[],
  options: TanStackToolOptions = {},
): ServerTool[] {
  return tools.map((tool) => {
    const definition = toolDefinition({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    });

    return definition.server(async (args, context) => {
      const output = await executeToolWithArgs(tool, args, {
        abortSignal: context?.abortSignal,
        onSpan: options.onSpan,
      });
      return options.limitOutput ? options.limitOutput(output) : output;
    });
  });
}

/**
 * Convert an array of tool specs to OpenAI function-calling format.
 */
export function toToolDefinitions(tools: ToolSpec[]): ToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters),
    },
  }));
}

/**
 * Execute a tool by name. Parses and validates args with Zod.
 */
export async function executeTool(
  tools: ToolSpec[],
  name: string,
  argsJson: string,
  context?: ToolExecutionContext,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return `Error: Unknown tool "${name}"`;
  }

  let rawArgs: unknown;
  try {
    rawArgs = JSON.parse(argsJson || "{}");
  } catch {
    return `Error: Invalid JSON arguments for tool "${name}": ${argsJson}`;
  }

  return executeToolWithArgs(tool, rawArgs, context);
}

async function executeToolWithArgs(
  tool: ToolSpec,
  rawArgs: unknown,
  context?: ToolExecutionContext,
): Promise<string> {
  const parsed = tool.parameters.safeParse(rawArgs);
  if (!parsed.success) {
    return `Error: Invalid arguments for tool "${tool.name}": ${parsed.error.message}`;
  }

  const startedAt = Date.now();
  let reused = false;
  const executionContext: ToolExecutionContext = {
    ...context,
    markToolReused: () => {
      reused = true;
      context?.markToolReused?.();
    },
  };
  try {
    context?.abortSignal?.throwIfAborted();
    const output = await tool.execute(parsed.data, executionContext);
    context?.abortSignal?.throwIfAborted();
    const endedAt = Date.now();
    await emitAgentSpan(context?.onSpan, {
      kind: "tool",
      name: tool.name,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      ok: true,
      ...(reused ? { reused: true } : {}),
    });
    return output;
  } catch (err) {
    const endedAt = Date.now();
    await emitAgentSpan(context?.onSpan, {
      kind: "tool",
      name: tool.name,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      ok: false,
      ...(reused ? { reused: true } : {}),
    });
    context?.abortSignal?.throwIfAborted();
    const msg = err instanceof Error ? err.message : String(err);
    return `Error executing tool "${tool.name}": ${msg}`;
  }
}

// ─── Minimal Zod → JSON Schema Converter ──────────────────────────────

/**
 * Convert a Zod schema to a JSON Schema object.
 * Supports the subset needed for tool definitions:
 * object, string, number, boolean, array, enum, optional, describe.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return convertSchema(schema);
}

function convertSchema(schema: z.ZodType): Record<string, unknown> {
  const desc = (schema as any)._zod?.def?.description;

  // Unwrap optional
  if (schema instanceof z.ZodOptional) {
    const inner = convertSchema((schema as any)._zod.def.innerType);
    if (desc) inner.description = desc;
    return inner;
  }

  // Unwrap default
  if (schema instanceof z.ZodDefault) {
    const inner = convertSchema((schema as any)._zod.def.innerType);
    if (desc) inner.description = desc;
    return inner;
  }

  // String
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    if (desc) result.description = desc;
    return result;
  }

  // Number
  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    if (desc) result.description = desc;
    return result;
  }

  // Boolean
  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: "boolean" };
    if (desc) result.description = desc;
    return result;
  }

  // Array
  if (schema instanceof z.ZodArray) {
    const result: Record<string, unknown> = {
      type: "array",
      items: convertSchema((schema as any)._zod.def.element),
    };
    if (desc) result.description = desc;
    return result;
  }

  // Enum (string literals)
  if (schema instanceof z.ZodEnum) {
    const result: Record<string, unknown> = {
      type: "string",
      enum: (schema as any)._zod.def.entries,
    };
    if (desc) result.description = desc;
    return result;
  }

  // Object
  if (schema instanceof z.ZodObject) {
    const shape = (schema as any)._zod.def.shape as Record<string, z.ZodType>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertSchema(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = {
      type: "object",
      properties,
    };
    if (required.length > 0) result.required = required;
    if (desc) result.description = desc;
    return result;
  }

  // Fallback
  const result: Record<string, unknown> = { type: "string" };
  if (desc) result.description = desc;
  return result;
}
