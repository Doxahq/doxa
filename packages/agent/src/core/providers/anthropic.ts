import type { AnyTextAdapter } from "@tanstack/ai";
import { createAnthropicChat, type AnthropicChatModel } from "@tanstack/ai-anthropic";
import type { FinalTurnToolPolicy } from "../agent-loop-policy";
import type { TokenUsage } from "../types";
import { toAnthropicJsonSchema } from "./anthropic-json-schema";
import { anthropicModelPrice } from "./anthropic-pricing";
import { anthropicPromptCache } from "./anthropic-prompt-cache";
import type { ModelProviderRuntime } from "./types";

/**
 * Keeps the tools defined and sets `tool_choice: none`. The conversation
 * already holds tool calls, and Anthropic rejects `tool_choice` without tools.
 */
const noToolCallsOnFinalTurn: FinalTurnToolPolicy = (turn) =>
  turn.tools.length === 0
    ? turn
    : { tools: turn.tools, modelOptions: { ...turn.modelOptions, tool_choice: "none" } };

/**
 * Anthropic's `input_tokens` leaves out cache reads and cache writes. Doxa
 * counts them in `promptTokens`, as OpenRouter does.
 */
function withCacheTokensInPrompt(usage: TokenUsage): TokenUsage {
  const promptTokens = usage.promptTokens + (usage.cachedTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  return {
    ...usage,
    promptTokens,
    totalTokens: promptTokens + usage.completionTokens,
  };
}

/**
 * A refused schema is a 400 that names the schema or `output_config`, for
 * example "Schema is too complex for compilation".
 */
function isResponseSchemaRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bcode 400\b|^400\b/.test(message) && /schema|output_config/i.test(message);
}

/**
 * Anthropic has no plain JSON mode, so `responseFormat` alone is not sent.
 * A call with a `responseSchema` uses structured outputs
 * (`output_config.format`) instead, which the adapter passes through.
 */
export const anthropicRuntime: ModelProviderRuntime = {
  defaultBaseUrl: "https://api.anthropic.com",
  createAdapter: (config, model) =>
    // The adapter types only the models it knows. The API accepts newer ones too.
    createAnthropicChat(model as AnthropicChatModel, config.apiKey, {
      baseURL: config.baseUrl,
      // Doxa retries in one place, `withModelCallRetry`, with its error classes.
      maxRetries: 0,
    }) as unknown as AnyTextAdapter,
  modelOptions: (call) => ({
    ...(call.temperature !== undefined && { temperature: call.temperature }),
    ...(call.maxTokens !== undefined && { max_tokens: call.maxTokens }),
    ...(call.responseSchema && {
      output_config: {
        format: {
          type: "json_schema",
          schema: toAnthropicJsonSchema(call.responseSchema.schema),
        },
      },
    }),
  }),
  finalTurnToolPolicy: noToolCallsOnFinalTurn,
  promptCache: anthropicPromptCache,
  normalizeUsage: withCacheTokensInPrompt,
  modelPrice: anthropicModelPrice,
  isResponseSchemaRejection,
};
