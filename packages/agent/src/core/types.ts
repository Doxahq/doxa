/**
 * Core Agent Library — Type Definitions
 * Standalone types for the provider, tool system, and agent loop.
 */

import type { ModelProvider } from "@doxahq/contracts";
import type { z } from "zod/v4";
import type { PromptCacheSetting } from "./prompt-cache";
import type { ModelCallRetryEvent, ModelCallRetryPolicy } from "./model-call-retry";
import type { ResponseSchema } from "./structured-output";

// ─── Provider Types ────────────────────────────────────────────────────

export interface ProviderConfig {
  /** The model API to call. Defaults to OpenRouter. */
  name?: ModelProvider;
  /** Base URL of the provider API */
  baseUrl: string;
  /** API key of the provider */
  apiKey: string;
  /** Default model ID */
  model: string;
  /** Prompt caching for providers that support it. Defaults to the shared policy. */
  promptCache?: PromptCacheSetting;
  /** Retries of transient failures before any output. `false` turns them off. */
  modelCallRetry?: ModelCallRetryPolicy | false;
  /** Called before each retry, for example to lower a writer width on throttling. */
  onModelCallRetry?: (retry: ModelCallRetryEvent) => void;
}

export interface Provider {
  config: ProviderConfig;
  /** Send a chat completion request */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Send a streaming chat completion request */
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface ChatRequest {
  model?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  /** Force JSON output */
  responseFormat?: "json" | "text";
  /** JSON Schema for a JSON response, when the provider supports one. */
  responseSchema?: ResponseSchema;
  temperature?: number;
  maxTokens?: number;
  /** Cancels the in-flight provider request and agent loop. */
  abortController?: AbortController;
}

export interface ChatResponse {
  message: AssistantMessage;
  usage?: TokenUsage;
  finishReason?: string;
  /** Provider generation id, when returned. Useful for usage auditing. */
  id?: string;
  /** Actual model used by the provider, when returned. */
  model?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-reported cached input tokens, when available. */
  cachedTokens?: number;
  /** Provider-reported cache-write tokens, when available. */
  cacheWriteTokens?: number;
  /** Provider-reported reasoning tokens, when available. */
  reasoningTokens?: number;
  /** Provider-reported total cost, when available. */
  cost?: number;
  /** Provider-reported prompt/input cost, when available. */
  promptCost?: number;
  /** Provider-reported completion/output cost, when available. */
  completionCost?: number;
  /** Provider upstream cost before any gateway markup, when available. */
  upstreamCost?: number;
}

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; arguments: string }
  | { type: "done"; message: AssistantMessage; finishReason?: string };

// ─── Message Types ─────────────────────────────────────────────────────

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ─── Tool Types ────────────────────────────────────────────────────────

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolSpec<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: T;
  execute: (args: z.infer<T>, context?: ToolExecutionContext) => Promise<string>;
}

export interface ToolExecutionContext {
  abortSignal?: AbortSignal;
  onSpan?: AgentSpanCallback;
  /** Marks the current invocation as served from a result cache. */
  markToolReused?: () => void;
}

// ─── Agent Types ───────────────────────────────────────────────────────

export type AgentLoopTermination =
  | "natural"
  | "forced_finalization"
  | "agent_loop_exhausted";

export interface AgentLoopPolicy {
  /**
   * Instruction appended before the configured final model iteration.
   * The final iteration receives no tools.
   */
  finalizationPrompt: string;
  /** Consecutive identical-call threshold at which execution is skipped. Default 3. */
  repeatedToolCallLimit?: number;
}

export interface AgentLoopReport {
  termination: AgentLoopTermination;
  maxSteps: number;
  steps: number;
  finalizationTriggered: boolean;
  repeatedToolCallsBlocked: number;
}

export interface AgentOptions {
  provider: Provider;
  systemPrompt: string;
  tools?: ToolSpec[];
  /** Force JSON response format (disables tools) */
  responseFormat?: "json" | "text";
  /**
   * JSON Schema the response must follow, for providers with constrained
   * decoding. A refused schema falls back to plain JSON mode once.
   */
  responseSchema?: ResponseSchema;
  /** Maximum model iterations, including a configured terminal turn (default 50). */
  maxSteps?: number;
  /** Optional fixed-loop enforcement. maxSteps includes the terminal text-only turn. */
  loopPolicy?: AgentLoopPolicy;
  temperature?: number;
  maxTokens?: number;
  /** Cancels model requests, subsequent loop iterations, and cancellable tools. */
  abortController?: AbortController;
  /** Idle timeout between streamed chunks for one model request. Default 120000ms. */
  modelCallTimeoutMs?: number;
  /** Absolute ceiling for one model request. Default 600000ms. */
  modelCallMaxDurationMs?: number;
  /** Override model for this run */
  model?: string;
  /** Max total characters of tool output retained in the conversation */
  maxToolOutputChars?: number;
  /** Max characters retained from a single tool call result */
  maxSingleToolOutputChars?: number;
  /** Stable business context attached to every provider call in this run. */
  usageContext?: AgentUsageContext;
  /** Request-scoped usage sink. Safe for concurrent hosted generations. */
  onUsage?: AgentUsageCallback;
  /** Request-scoped latency span sink. Failures never affect generation. */
  onSpan?: AgentSpanCallback;
}

export type AgentUsageOperation =
  | "analysis"
  | "structure"
  | "structure_review"
  | "page_write"
  | "mdx_repair"
  | "rest_extraction";

export interface AgentUsageContext {
  operation: AgentUsageOperation;
  pageId?: string;
  pageTitle?: string;
  pageRetry?: number;
  attempt?: number;
}

export interface AgentUsageRecord {
  callId: string;
  model: string;
  iteration: number;
  providerGenerationId?: string;
  usage: TokenUsage;
  context: AgentUsageContext;
  durationMs?: number;
  finishReason?: string;
  recordedAt: string;
}

export type AgentUsageCallback = (
  record: AgentUsageRecord,
) => Promise<void> | void;

export type AgentSpanKind = "model" | "tool" | "validation";

export interface AgentSpanRecord {
  kind: AgentSpanKind;
  /** Tool name, validation operation, or model usage operation. */
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ok: boolean;
  /** True when cached or pooled work avoided the underlying operation. */
  reused?: boolean;
  context?: AgentUsageContext;
}

export type AgentSpanCallback = (
  span: AgentSpanRecord,
) => Promise<void> | void;

export interface RunResult {
  /** Final text content from the assistant */
  text: string;
  /** Full message history */
  messages: Message[];
  /** Number of tool-call loop iterations */
  steps: number;
  /** Aggregated token usage reported by the provider for this run */
  usage?: TokenUsage;
  /** Finish reason from the final provider response, when available */
  finishReason?: string;
  /**
   * Deterministic loop termination and guardrail accounting.
   * Doxa's run() implementations always set this; optional for fixture compatibility.
   */
  loop?: AgentLoopReport;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string }
  | { type: "tool_result"; id: string; name: string; output: string }
  | { type: "message_complete"; message: AssistantMessage }
  | { type: "done"; text: string };
