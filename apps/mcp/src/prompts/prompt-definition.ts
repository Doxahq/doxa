import type { GetPromptResult } from "@modelcontextprotocol/server";
import type { z } from "zod";

/** MCP sends prompt arguments as strings, so every field is a string schema. */
export type PromptArgsSchema = z.ZodObject<z.ZodRawShape, z.core.$strict>;

/**
 * A prompt is a tested workflow (spec 8.2): plain text that names the steps
 * and the exact tools. It reads nothing and calls nothing, so it needs no
 * scope; the tools it names check their own scopes and approval policy.
 */
export interface McpPromptDefinition<TArgs extends PromptArgsSchema> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly args: TArgs;
  // Method syntax on purpose: it lets a list of prompts with different
  // schemas share the erased `AnyMcpPrompt` type.
  text(args: z.infer<TArgs>): string;
}

export type AnyMcpPrompt = McpPromptDefinition<PromptArgsSchema>;

export function defineMcpPrompt<TArgs extends PromptArgsSchema>(
  definition: McpPromptDefinition<TArgs>,
): McpPromptDefinition<TArgs> {
  return definition;
}

/** One user message with the workflow, as `prompts/get` returns it. */
export function toPromptResult(
  prompt: AnyMcpPrompt,
  text: string,
): GetPromptResult {
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}
