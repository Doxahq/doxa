import type { AnyTextAdapter, ChatMiddleware, SystemPrompt } from "@tanstack/ai";
import type { FinalTurnToolPolicy } from "../agent-loop-policy";
import type { ModelPriceLookup } from "../pricing";
import type { PromptCachePolicy } from "../prompt-cache";
import type { ResponseSchema } from "../structured-output";
import type { ProviderConfig, TokenUsage } from "../types";

/** The model call settings that every provider supports, in Doxa's own names. */
export interface ModelCallOptions {
  responseFormat?: "json" | "text";
  /** The JSON Schema of a JSON call. Providers without constrained decoding ignore it. */
  responseSchema?: ResponseSchema;
  temperature?: number;
  maxTokens?: number;
}

/**
 * How a provider caches a prompt prefix. The system prompt holds the rules
 * and context that every call of a run shares, so it carries the first
 * marker. The middleware moves a second marker to the newest message before
 * each model call, so each step of an agent loop reads the earlier steps.
 */
export interface PromptCacheSupport {
  systemPrompts(systemPrompt: string, policy: PromptCachePolicy): SystemPrompt[];
  middleware(policy: PromptCachePolicy): ChatMiddleware;
}

/**
 * Everything that changes from one model API to another. The optional
 * members are capabilities: a provider without one keeps the plain behavior.
 */
export interface ModelProviderRuntime {
  readonly defaultBaseUrl: string;
  createAdapter(config: ProviderConfig, model: string): AnyTextAdapter;
  /** Converts the shared call settings to the provider's `modelOptions` names. */
  modelOptions(call: ModelCallOptions): Record<string, unknown>;
  finalTurnToolPolicy: FinalTurnToolPolicy;
  promptCache?: PromptCacheSupport;
  /**
   * Brings the provider's usage numbers to Doxa's meaning, where
   * `promptTokens` counts every input token, cache reads and writes included.
   */
  normalizeUsage?(usage: TokenUsage): TokenUsage;
  /** List prices, for a provider that sends no cost with its responses. */
  modelPrice?: ModelPriceLookup;
  /** True when a call failed because the provider refused its response schema. */
  isResponseSchemaRejection?(error: unknown): boolean;
}
