/**
 * Core Agent Library — Barrel Exports
 * Standalone, reusable agent library with zero AI SDK dependencies.
 */

// Provider
export {
  createProvider,
  modelProvider,
  openrouter,
  providerCachesPrompts,
} from "./provider";

// Tool system
export { defineTool, toToolDefinitions, executeTool, zodToJsonSchema } from "./tool";

// Agent loop
export { run, stream } from "./agent";
export { emitAgentSpan } from "./span";
export {
  DEFAULT_REPEATED_TOOL_CALL_LIMIT,
  isAgentLoopExhausted,
} from "./agent-loop-policy";
export {
  DEFAULT_MODEL_CALL_MAX_DURATION_MS,
  DEFAULT_MODEL_CALL_TIMEOUT_MS,
  ModelCallTimeoutError,
} from "./model-call-deadline";
export type { ModelCallTimeoutKind } from "./model-call-deadline";
export { captureUsage, addUsage, emptyUsage, recordUsage, subscribeUsage } from "./usage";
export type { UsageRecord, UsageMetadata } from "./usage";
export {
  DEFAULT_PROMPT_CACHE_POLICY,
  resolvePromptCachePolicy,
} from "./prompt-cache";
export type {
  PromptCachePolicy,
  PromptCacheSetting,
  PromptCacheTtl,
} from "./prompt-cache";
export { priceTokenUsage, withPricedCost } from "./pricing";
export {
  ModelCallError,
  classifyModelCallFailure,
  isRunStoppingModelError,
  modelCallErrorPolicy,
} from "./model-call-errors";
export type { ModelCallErrorClass, ModelCallErrorClassPolicy } from "./model-call-errors";
export {
  DEFAULT_MODEL_CALL_RETRY_POLICY,
  retryDelayMs,
  withModelCallRetry,
} from "./model-call-retry";
export type {
  ModelCallRetryEvent,
  ModelCallRetryHooks,
  ModelCallRetryPolicy,
} from "./model-call-retry";
export {
  isResponseSchemaRejected,
  resetRejectedResponseSchemas,
} from "./structured-output";
export type { JsonSchema, ResponseSchema } from "./structured-output";
export type { ModelPrice, ModelPriceLookup, TokenPrices, UsageCost } from "./pricing";
export {
  DocsCostTracker,
  isDevInvocation,
  isDocsCostTrackingEnabled,
  isTruthyEnvValue,
  startDocsCostTracking,
} from "./cost-tracking";
export type { DocsCostTrackerOptions, DocsCostTrackingReport, DocsCostTrackingStatus } from "./cost-tracking";

// Built-in tools
export {
  explorationTools,
  readOnlyTools,
  writerTools,
  validatePageTool,
  VALIDATE_PAGE_TOOL_DESCRIPTION,
} from "./tools";
export type { ValidatePageToolOptions } from "./tools";
export {
  createTrackedTools,
  createTrackedReadOnlyTools,
  createTrackedExplorationTools,
} from "./tools";
export type { TrackedTools } from "./tools";
export type {
  ToolResultCache,
  ToolResultCacheOptions,
  TrackedToolsOptions,
} from "./tools";
export { createToolResultCache } from "./tools";
export { isProtectedFilePath } from "./tools/file-access-rules";

// Types
export type {
  Provider,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolCall,
  ToolDefinition,
  ToolSpec,
  AgentOptions,
  AgentUsageCallback,
  AgentUsageContext,
  AgentUsageOperation,
  AgentUsageRecord,
  AgentSpanCallback,
  AgentSpanKind,
  AgentSpanRecord,
  AgentLoopPolicy,
  AgentLoopReport,
  AgentLoopTermination,
  RunResult,
  StreamEvent,
  TokenUsage,
} from "./types";
