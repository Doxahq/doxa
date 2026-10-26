/**
 * Core Agent Library - Provider
 * Model provider facade backed by TanStack AI adapters. The provider name in
 * the config picks the runtime (OpenRouter by default).
 */

import {
  chat as tanStackChat,
  type AnyTextAdapter,
  type ChatMiddleware,
  type ModelMessage,
  type SystemPrompt,
} from "@tanstack/ai";
import {
  DEFAULT_DOXA_WRITER_MODEL,
  DEFAULT_MODEL_PROVIDER,
  type ModelProvider,
} from "@doxahq/contracts";
import type { FinalTurnToolPolicy } from "./agent-loop-policy";
import { withPricedCost } from "./pricing";
import {
  DEFAULT_PROMPT_CACHE_POLICY,
  resolvePromptCachePolicy,
  type PromptCacheSetting,
} from "./prompt-cache";
import { modelCallErrorFromChunk } from "./model-call-errors";
import {
  DEFAULT_MODEL_CALL_RETRY_POLICY,
  withModelCallRetry,
  type ModelCallRetryEvent,
} from "./model-call-retry";
import { runErrorFinishReason } from "./provider-errors";
import { modelProviderRuntime, type ModelCallOptions } from "./providers";
import type {
  AssistantMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  Message,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "./types";

interface TanStackProviderRuntime {
  createAdapter: (model?: string) => AnyTextAdapter;
  modelOptions: (call: ModelCallOptions) => Record<string, unknown>;
  finalTurnToolPolicy: FinalTurnToolPolicy;
  /** The system prompt in the provider's form, with cache markers when it caches. */
  systemPrompts: (systemPrompt: string) => SystemPrompt[];
  /** Provider middleware that every chat call runs after Doxa's own. */
  middleware: () => ChatMiddleware[];
  /** Normalizes the provider's usage and adds a list-price cost when it sent none. */
  finishUsage: (model: string, usage: TokenUsage) => TokenUsage;
  /** True when calls with the same prefix read it from the provider's cache. */
  cachesPrompts: boolean;
  /** The model API name, for logs and per-provider memory. */
  providerName: string;
  isResponseSchemaRejection: (error: unknown) => boolean;
}

const runtimeByProvider = new WeakMap<Provider, TanStackProviderRuntime>();

export function getTanStackProviderRuntime(
  provider: Provider,
): TanStackProviderRuntime | undefined {
  return runtimeByProvider.get(provider);
}

/** False for injected providers, which have no provider runtime. */
export function providerCachesPrompts(provider: Provider): boolean {
  return runtimeByProvider.get(provider)?.cachesPrompts ?? false;
}

/**
 * Create a provider facade for the model API named in `config.name`.
 *
 * The public Doxa Provider shape stays stable for tests and advanced
 * injection, while the default runtime delegates model calls to TanStack AI.
 */
export function createProvider(config: ProviderConfig): Provider {
  const runtime = createTanStackRuntime(config);
  const provider: Provider = {
    config,
    chat: (request) => chat(config, runtime, request),
    chatStream: (request) => chatStream(runtime, request),
  };

  runtimeByProvider.set(provider, runtime);

  return provider;
}

/** Creates a provider for `provider` with its default API URL. */
export function modelProvider(opts: {
  provider?: ModelProvider;
  /** One of `apiKey` and `authToken` is required. */
  apiKey?: string;
  authToken?: string;
  model?: string;
  promptCache?: PromptCacheSetting;
  onModelCallRetry?: (retry: ModelCallRetryEvent) => void;
}): Provider {
  return createProvider({
    name: opts.provider,
    baseUrl: modelProviderRuntime(opts.provider).defaultBaseUrl,
    apiKey: opts.apiKey ?? "",
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
    model: opts.model || DEFAULT_DOXA_WRITER_MODEL,
    promptCache: opts.promptCache,
    onModelCallRetry: opts.onModelCallRetry,
  });
}

/**
 * Convenience factory for OpenRouter.
 * Reads OPENROUTER_API_KEY from env and defaults to the configured writer model.
 */
export function openrouter(opts?: { apiKey?: string; model?: string }): Provider {
  const apiKey = opts?.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required. Set the OPENROUTER_API_KEY environment variable or pass apiKey."
    );
  }
  return modelProvider({ provider: "openrouter", apiKey, model: opts?.model });
}

function createTanStackRuntime(config: ProviderConfig): TanStackProviderRuntime {
  const runtime = modelProviderRuntime(config.name);
  const cachePolicy = resolvePromptCachePolicy(config.promptCache);
  const promptCache = cachePolicy ? runtime.promptCache : undefined;
  const pricedCacheTtl = (cachePolicy ?? DEFAULT_PROMPT_CACHE_POLICY).ttl;
  return {
    createAdapter: (model) => {
      const adapter = runtime.createAdapter(config, model || config.model);
      return config.modelCallRetry === false
        ? adapter
        : withModelCallRetry(adapter, config.modelCallRetry ?? DEFAULT_MODEL_CALL_RETRY_POLICY, {
            onRetry: (retry) => {
              logModelCallRetry(config, model || config.model, retry);
              config.onModelCallRetry?.(retry);
            },
          });
    },
    modelOptions: (call) => runtime.modelOptions(call),
    finalTurnToolPolicy: runtime.finalTurnToolPolicy,
    systemPrompts: (systemPrompt) =>
      promptCache && cachePolicy
        ? promptCache.systemPrompts(systemPrompt, cachePolicy)
        : [systemPrompt],
    middleware: () =>
      promptCache && cachePolicy ? [promptCache.middleware(cachePolicy)] : [],
    cachesPrompts: Boolean(promptCache && cachePolicy),
    providerName: config.name ?? DEFAULT_MODEL_PROVIDER,
    isResponseSchemaRejection: (error) =>
      runtime.isResponseSchemaRejection?.(error) ?? false,
    finishUsage: (model, usage) =>
      withPricedCost(
        runtime.normalizeUsage?.(usage) ?? usage,
        runtime.modelPrice?.(model),
        pricedCacheTtl,
      ),
  };
}

async function chat(
  config: ProviderConfig,
  runtime: TanStackProviderRuntime,
  request: ChatRequest,
): Promise<ChatResponse> {
  const model = request.model || config.model;
  const usageState: { usage?: TokenUsage; finishReason?: string | null } = {};
  const response = await tanStackChat({
    adapter: runtime.createAdapter(request.model),
    systemPrompts: systemPromptsFromMessages(runtime, request.messages),
    messages: modelMessagesFromMessages(request.messages),
    stream: false,
    modelOptions: runtime.modelOptions(request),
    middleware: [captureUsageMiddleware(usageState), ...runtime.middleware()],
    abortController: request.abortController,
  } as any);

  return {
    message: {
      role: "assistant",
      content: typeof response === "string" ? response : String(response ?? ""),
    },
    usage: usageState.usage && runtime.finishUsage(model, usageState.usage),
    finishReason: usageState.finishReason ?? undefined,
    model,
  };
}

async function* chatStream(
  runtime: TanStackProviderRuntime,
  request: ChatRequest,
): AsyncIterable<ChatStreamEvent> {
  const usageState: { usage?: TokenUsage; finishReason?: string | null } = {};
  const stream = tanStackChat({
    adapter: runtime.createAdapter(request.model),
    systemPrompts: systemPromptsFromMessages(runtime, request.messages),
    messages: modelMessagesFromMessages(request.messages),
    modelOptions: runtime.modelOptions(request),
    middleware: [captureUsageMiddleware(usageState), ...runtime.middleware()],
    abortController: request.abortController,
  } as any);

  let content = "";
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream as AsyncIterable<any>) {
    switch (chunk.type) {
      case "TEXT_MESSAGE_CONTENT":
        if (typeof chunk.delta === "string") {
          content += chunk.delta;
          yield { type: "text_delta", text: chunk.delta };
        }
        break;
      case "TOOL_CALL_START": {
        const id = String(chunk.toolCallId ?? "");
        const name = String(chunk.toolCallName ?? chunk.toolName ?? "");
        if (id) {
          toolCalls.set(id, { id, name, arguments: "" });
          yield { type: "tool_call_start", index: chunk.index ?? 0, id, name };
        }
        break;
      }
      case "TOOL_CALL_ARGS": {
        const id = String(chunk.toolCallId ?? "");
        const delta = typeof chunk.delta === "string" ? chunk.delta : "";
        const existing = id ? toolCalls.get(id) : undefined;
        if (existing) existing.arguments += delta;
        if (id && delta) {
          yield { type: "tool_call_delta", index: chunk.index ?? 0, arguments: delta };
        }
        break;
      }
      case "RUN_ERROR": {
        const finishReason = runErrorFinishReason(chunk);
        if (!finishReason) throw modelCallErrorFromChunk(chunk);
        usageState.finishReason = finishReason;
        break;
      }
      case "RUN_FINISHED":
        // A stop at the token limit stays the reason, whatever finishes the run after it.
        if (usageState.finishReason !== "length") {
          usageState.finishReason = chunk.finishReason ?? usageState.finishReason;
        }
        break;
    }
  }

  const message: AssistantMessage = {
    role: "assistant",
    content: content || null,
    toolCalls: toolCalls.size > 0
      ? Array.from(toolCalls.values()).map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: { name: toolCall.name, arguments: toolCall.arguments },
        }))
      : undefined,
  };
  yield {
    type: "done",
    message,
    finishReason: usageState.finishReason ?? undefined,
  };
}

function systemPromptsFromMessages(
  runtime: TanStackProviderRuntime,
  messages: Message[],
): SystemPrompt[] {
  const contents = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const last = contents.pop();
  // One cache marker, after the last system block, covers all of them.
  return last === undefined ? contents : [...contents, ...runtime.systemPrompts(last)];
}

function modelMessagesFromMessages(messages: Message[]): ModelMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message): ModelMessage => {
      if (message.role === "tool") {
        return {
          role: "tool",
          toolCallId: message.toolCallId,
          content: message.content,
        };
      }
      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: message.content,
          toolCalls: message.toolCalls,
        };
      }
      return {
        role: "user",
        content: message.content,
      };
    });
}

function captureUsageMiddleware(
  state: { usage?: TokenUsage; finishReason?: string | null },
): ChatMiddleware {
  return {
    name: "doxa-provider-usage",
    onUsage: (_ctx, usage) => {
      state.usage = mapUsage(usage);
    },
    onFinish: (_ctx, info) => {
      state.finishReason = info.finishReason;
      if (info.usage) state.usage = mapUsage(info.usage);
    },
  };
}

function mapUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  costDetails?: {
    upstreamInputCost?: number;
    upstreamOutputCost?: number;
    upstreamCost?: number;
  };
  promptTokensDetails?: {
    cachedTokens?: number;
    cacheWriteTokens?: number;
  };
  completionTokensDetails?: {
    reasoningTokens?: number;
  };
}): TokenUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.promptTokensDetails?.cachedTokens,
    cacheWriteTokens: usage.promptTokensDetails?.cacheWriteTokens,
    reasoningTokens: usage.completionTokensDetails?.reasoningTokens,
    cost: usage.cost ?? usage.costDetails?.upstreamCost,
    promptCost: usage.costDetails?.upstreamInputCost,
    completionCost: usage.costDetails?.upstreamOutputCost,
    upstreamCost: usage.costDetails?.upstreamCost,
  };
}

function logModelCallRetry(
  config: ProviderConfig,
  model: string,
  retry: ModelCallRetryEvent,
): void {
  console.warn(JSON.stringify({
    service: "doxa-agent",
    eventType: "model_call_retry",
    provider: config.name ?? DEFAULT_MODEL_PROVIDER,
    model,
    attempt: retry.attempt,
    delayMs: retry.delayMs,
    errorClass: retry.errorClass,
    reason: retry.reason,
  }));
}
