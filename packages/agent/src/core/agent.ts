/**
 * Core Agent Library - Agent Loop
 * Implements run() and stream() over TanStack AI beta for the default provider,
 * with the legacy loop retained for injected test providers.
 */

import {
  chat as tanStackChat,
  combineStrategies,
  maxIterations,
  untilFinishReason,
  type ChatMiddleware,
  type ModelMessage,
} from "@tanstack/ai";
import type {
  AgentOptions,
  RunResult,
  StreamEvent,
  Message,
  AssistantMessage,
  ChatResponse,
  AgentUsageRecord,
  AgentSpanRecord,
  TokenUsage,
} from "./types";
import {
  toToolDefinitions,
  executeTool,
  toTanStackServerTools,
} from "./tool";
import {
  classifyAgentLoop,
  createAgentLoopMiddleware,
  createAgentLoopState,
  observeToolCall,
  parseToolArguments,
  REPEATED_TOOL_CALL_RESULT,
  type AgentLoopState,
} from "./agent-loop-policy";
import { getTanStackProviderRuntime } from "./provider";
import { modelCallErrorFromChunk } from "./model-call-errors";
import { runErrorFinishReason } from "./provider-errors";
import { addUsage, emptyUsage, recordUsage } from "./usage";
import {
  createLinkedAbortController,
  createModelCallDeadline,
  DEFAULT_MODEL_CALL_MAX_DURATION_MS,
  DEFAULT_MODEL_CALL_TIMEOUT_MS,
  type ModelCallDeadline,
} from "./model-call-deadline";
import { emitAgentSpan } from "./span";
import { truncateUntrustedAwareOutput } from "./untrusted-content";
import {
  isResponseSchemaRejected,
  rememberRejectedResponseSchema,
} from "./structured-output";

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 48_000;
const DEFAULT_MAX_SINGLE_TOOL_OUTPUT_CHARS = 8_000;

interface TanStackExecutionState {
  usage: TokenUsage;
  finishReason?: string;
  steps: number;
  sawUsage: boolean;
  iterationStartedAt: Map<number, number>;
  spannedIterations: Set<number>;
}

interface TanStackChunkAccumulator {
  text: string;
  currentMessageId?: string;
  finishReason?: string;
  toolCalls: Map<string, { id: string; name: string; arguments: string }>;
  emittedToolResults: Set<string>;
}

interface LegacyIterationRequest {
  terminal: boolean;
  messages: Message[];
}

function getLastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

/**
 * Run to completion - simple API for single-shot or multi-turn with tools.
 */
export async function run(options: AgentOptions, userMessage: string): Promise<RunResult> {
  const runtime = getTanStackProviderRuntime(options.provider);
  if (!runtime) return runLegacy(options, userMessage);

  const schema = options.responseSchema;
  if (!schema || isResponseSchemaRejected(runtime.providerName, schema)) {
    return runWithTanStack(withoutResponseSchema(options), userMessage);
  }
  try {
    return await runWithTanStack(options, userMessage);
  } catch (error) {
    if (!runtime.isResponseSchemaRejection(error)) throw error;
    rememberRejectedResponseSchema(runtime.providerName, schema, error);
    return runWithTanStack(withoutResponseSchema(options), userMessage);
  }
}

function withoutResponseSchema(options: AgentOptions): AgentOptions {
  if (!options.responseSchema) return options;
  const { responseSchema: _schema, ...rest } = options;
  return rest;
}

/**
 * Stream events as they happen - for progress reporting.
 */
export async function* stream(
  options: AgentOptions,
  userMessage: string
): AsyncGenerator<StreamEvent> {
  const runtime = getTanStackProviderRuntime(options.provider);
  if (runtime) {
    const schema = options.responseSchema;
    const rejected = schema && isResponseSchemaRejected(runtime.providerName, schema);
    yield* streamWithTanStack(rejected ? withoutResponseSchema(options) : options, userMessage);
    return;
  }
  yield* streamLegacy(options, userMessage);
}

async function runWithTanStack(options: AgentOptions, userMessage: string): Promise<RunResult> {
  const abortScope = createLinkedAbortController(
    options.abortController,
  );
  const deadline = createModelCallDeadline(
    abortScope.controller,
    options.modelCallTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS,
    options.modelCallMaxDurationMs ?? DEFAULT_MODEL_CALL_MAX_DURATION_MS,
  );
  const scopedOptions = {
    ...options,
    abortController: abortScope.controller,
  };
  const state = createExecutionState();
  const maxSteps = scopedOptions.maxSteps ?? DEFAULT_MAX_STEPS;
  const loopState = createAgentLoopState(
    scopedOptions.loopPolicy,
    maxSteps,
  );
  const accumulator = createChunkAccumulator();
  const tanStackStream = createTanStackChatStream(
    scopedOptions,
    userMessage,
    state,
    loopState,
    deadline,
  );

  try {
    for await (const chunk of tanStackStream) {
      handleTanStackChunk(accumulator, chunk);
    }
    abortScope.controller.signal.throwIfAborted();

    const text = accumulator.text;
    return {
      text,
      messages: [
        { role: "system", content: scopedOptions.systemPrompt },
        { role: "user", content: userMessage },
        { role: "assistant", content: text || null },
      ],
      steps: state.steps || 1,
      usage: state.usage,
      finishReason: accumulator.finishReason ?? state.finishReason,
      loop: classifyAgentLoop(
        loopState,
        accumulator.finishReason ?? state.finishReason,
        text,
        state.steps || 1,
      ),
    };
  } catch (error) {
    throw deadline.timeoutError() ?? error;
  } finally {
    deadline.cleanup();
    abortScope.cleanup();
  }
}

async function* streamWithTanStack(
  options: AgentOptions,
  userMessage: string,
): AsyncGenerator<StreamEvent> {
  const abortScope = createLinkedAbortController(
    options.abortController,
  );
  const deadline = createModelCallDeadline(
    abortScope.controller,
    options.modelCallTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS,
    options.modelCallMaxDurationMs ?? DEFAULT_MODEL_CALL_MAX_DURATION_MS,
  );
  const scopedOptions = {
    ...options,
    abortController: abortScope.controller,
  };
  const state = createExecutionState();
  const maxSteps = scopedOptions.maxSteps ?? DEFAULT_MAX_STEPS;
  const loopState = createAgentLoopState(
    scopedOptions.loopPolicy,
    maxSteps,
  );
  const accumulator = createChunkAccumulator();
  const tanStackStream = createTanStackChatStream(
    scopedOptions,
    userMessage,
    state,
    loopState,
    deadline,
  );

  try {
    for await (const chunk of tanStackStream) {
      for (const event of handleTanStackChunk(accumulator, chunk)) {
        yield event;
      }
    }
    abortScope.controller.signal.throwIfAborted();

    const message: AssistantMessage = {
      role: "assistant",
      content: accumulator.text || null,
      toolCalls: accumulator.toolCalls.size
        ? Array.from(accumulator.toolCalls.values()).map((toolCall) => ({
            id: toolCall.id,
            type: "function" as const,
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          }))
        : undefined,
    };
    yield { type: "message_complete", message };
    yield { type: "done", text: accumulator.text };
  } catch (error) {
    throw deadline.timeoutError() ?? error;
  } finally {
    deadline.cleanup();
    abortScope.cleanup();
  }
}

function createTanStackChatStream(
  options: AgentOptions,
  userMessage: string,
  state: TanStackExecutionState,
  loopState: AgentLoopState,
  deadline: ModelCallDeadline,
): AsyncIterable<any> {
  const runtime = getTanStackProviderRuntime(options.provider);
  if (!runtime) {
    throw new Error("TanStack runtime is not available for this provider.");
  }

  const maxSteps = loopState.maxSteps;
  const tools = options.responseFormat === "json"
    ? undefined
    : toTanStackServerTools(options.tools ?? [], {
        limitOutput: createToolOutputLimiter(options),
        onSpan: options.onSpan,
      });

  return tanStackChat({
    adapter: runtime.createAdapter(options.model),
    systemPrompts: runtime.systemPrompts(options.systemPrompt),
    messages: [{ role: "user", content: userMessage }] satisfies ModelMessage[],
    tools: tools && tools.length > 0 ? tools : undefined,
    modelOptions: runtime.modelOptions(options),
    agentLoopStrategy: combineStrategies([
      maxIterations(maxSteps),
      untilFinishReason(["stop"]),
    ]),
    middleware: [
      createAgentLoopMiddleware(loopState, runtime.finalTurnToolPolicy),
      deadline.middleware,
      createDoxaUsageMiddleware(state, options, runtime.finishUsage),
      ...runtime.middleware(),
    ],
    abortController: options.abortController,
  } as any) as AsyncIterable<any>;
}

function createToolOutputLimiter(options: AgentOptions): (output: string) => string {
  const maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const maxSingleToolOutputChars = options.maxSingleToolOutputChars ?? DEFAULT_MAX_SINGLE_TOOL_OUTPUT_CHARS;
  let retainedToolOutputChars = 0;

  return (output) => {
    const remainingBudget = Math.max(0, maxToolOutputChars - retainedToolOutputChars);
    const allowedChars = Math.min(maxSingleToolOutputChars, remainingBudget);
    const retainedOutput = truncateToolOutput(output, allowedChars);
    retainedToolOutputChars += retainedOutput.length;
    return retainedOutput;
  };
}

function createDoxaUsageMiddleware(
  state: TanStackExecutionState,
  options: AgentOptions,
  finishUsage: (model: string, usage: TokenUsage) => TokenUsage,
): ChatMiddleware {
  const emitModelSpan = async (
    iterationIndex: number,
    ok: boolean,
  ): Promise<number> => {
    const timing = modelIterationTiming(state, iterationIndex);
    if (state.spannedIterations.has(iterationIndex)) return timing.durationMs;
    state.spannedIterations.add(iterationIndex);
    await emitAgentSpan(options.onSpan, modelSpan(options, timing, ok));
    return timing.durationMs;
  };

  return {
    name: "doxa-usage",
    onIteration: (_ctx, info) => {
      state.steps = Math.max(state.steps, info.iteration + 1);
      state.iterationStartedAt.set(info.iteration, Date.now());
    },
    onUsage: async (ctx, usage) => {
      const model = ctx.model || options.model || options.provider.config.model;
      const mapped = finishUsage(model, mapTanStackUsage(usage));
      state.usage = addUsage(state.usage, mapped);
      state.sawUsage = true;
      const durationMs = await emitModelSpan(ctx.iteration, true);
      await emitUsage(options, mapped, {
        iteration: ctx.iteration + 1,
        model,
        durationMs,
      });
    },
    onFinish: async (ctx, info) => {
      state.finishReason = info.finishReason ?? undefined;
      const durationMs = await emitModelSpan(ctx.iteration, true);
      if (!state.sawUsage && info.usage) {
        const model = ctx.model || options.model || options.provider.config.model;
        const mapped = finishUsage(model, mapTanStackUsage(info.usage));
        state.usage = addUsage(state.usage, mapped);
        await emitUsage(options, mapped, {
          iteration: Math.max(1, state.steps),
          model,
          durationMs,
          finishReason: info.finishReason ?? undefined,
        });
      }
    },
    onAbort: async (ctx) => {
      await emitModelSpan(ctx.iteration, false);
    },
    onError: async (ctx) => {
      await emitModelSpan(ctx.iteration, false);
    },
  };
}

function createExecutionState(): TanStackExecutionState {
  return {
    usage: emptyUsage(),
    steps: 0,
    sawUsage: false,
    iterationStartedAt: new Map(),
    spannedIterations: new Set(),
  };
}

interface ModelSpanTiming {
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

function modelIterationTiming(
  state: TanStackExecutionState,
  iterationIndex: number,
): ModelSpanTiming {
  const endedAt = Date.now();
  const startedAt = state.iterationStartedAt.get(iterationIndex) ?? endedAt;
  return {
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
  };
}

function modelSpan(
  options: AgentOptions,
  timing: ModelSpanTiming,
  ok: boolean,
): AgentSpanRecord {
  return {
    kind: "model",
    name: options.usageContext?.operation ?? "model",
    ...timing,
    ok,
    ...(options.usageContext ? { context: options.usageContext } : {}),
  };
}

function createChunkAccumulator(): TanStackChunkAccumulator {
  return {
    text: "",
    toolCalls: new Map(),
    emittedToolResults: new Set(),
  };
}

function createLegacyIterationRequest(
  messages: Message[],
  state: AgentLoopState,
  step: number,
): LegacyIterationRequest {
  const policy = state.policy;
  if (!policy || step !== state.maxSteps) {
    return { terminal: false, messages };
  }

  state.finalizationTriggered = true;
  // A user turn, not an assistant turn: newer Claude models reject a
  // conversation that ends with an assistant message (prefill).
  return {
    terminal: true,
    messages: [
      ...messages,
      {
        role: "user",
        content: policy.finalizationPrompt,
      },
    ],
  };
}

function handleTanStackChunk(
  accumulator: TanStackChunkAccumulator,
  chunk: any,
): StreamEvent[] {
  switch (chunk.type) {
    case "TEXT_MESSAGE_START": {
      const messageId = String(chunk.messageId ?? "");
      if (messageId && messageId !== accumulator.currentMessageId) {
        accumulator.currentMessageId = messageId;
        accumulator.text = "";
      }
      return [];
    }
    case "TEXT_MESSAGE_CONTENT": {
      const delta = typeof chunk.delta === "string" ? chunk.delta : "";
      if (!delta) return [];
      const messageId = String(chunk.messageId ?? "");
      if (messageId && messageId !== accumulator.currentMessageId) {
        accumulator.currentMessageId = messageId;
        accumulator.text = "";
      }
      accumulator.text += delta;
      return [{ type: "text_delta", text: delta }];
    }
    case "TOOL_CALL_START": {
      const id = String(chunk.toolCallId ?? "");
      if (!id) return [];
      const name = String(chunk.toolCallName ?? chunk.toolName ?? "");
      accumulator.toolCalls.set(id, { id, name, arguments: "" });
      return [{ type: "tool_call_start", id, name }];
    }
    case "TOOL_CALL_ARGS": {
      const id = String(chunk.toolCallId ?? "");
      const delta = typeof chunk.delta === "string" ? chunk.delta : "";
      const existing = id ? accumulator.toolCalls.get(id) : undefined;
      if (existing) existing.arguments += delta;
      if (!id || !delta) return [];
      return [{ type: "tool_call_delta", id, arguments: delta }];
    }
    case "TOOL_CALL_END": {
      const id = String(chunk.toolCallId ?? "");
      if (!id) return [];
      const name = String(chunk.toolCallName ?? chunk.toolName ?? accumulator.toolCalls.get(id)?.name ?? "");
      const events: StreamEvent[] = [{ type: "tool_call_end", id }];
      if (chunk.result !== undefined && !accumulator.emittedToolResults.has(id)) {
        accumulator.emittedToolResults.add(id);
        events.push({
          type: "tool_result",
          id,
          name,
          output: stringifyToolResult(chunk.result),
        });
      }
      return events;
    }
    case "TOOL_CALL_RESULT": {
      const id = String(chunk.toolCallId ?? "");
      if (!id || accumulator.emittedToolResults.has(id)) return [];
      accumulator.emittedToolResults.add(id);
      const name = accumulator.toolCalls.get(id)?.name ?? "";
      return [{
        type: "tool_result",
        id,
        name,
        output: stringifyToolResult(chunk.content),
      }];
    }
    case "RUN_FINISHED":
      // A stop at the token limit stays the reason, whatever finishes the run after it.
      if (accumulator.finishReason !== "length") {
        accumulator.finishReason = chunk.finishReason ?? undefined;
      }
      return [];
    case "RUN_ERROR": {
      const finishReason = runErrorFinishReason(chunk);
      if (!finishReason) throw modelCallErrorFromChunk(chunk);
      accumulator.finishReason = finishReason;
      return [];
    }
    default:
      return [];
  }
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

function mapTanStackUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  costDetails?: {
    upstreamCost?: number;
    upstreamInputCost?: number;
    upstreamOutputCost?: number;
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

async function emitUsage(
  options: AgentOptions,
  usage: TokenUsage,
  metadata: {
    iteration: number;
    model: string;
    providerGenerationId?: string;
    durationMs?: number;
    finishReason?: string;
  },
): Promise<void> {
  recordUsage(usage, {
    model: metadata.model,
    generationId: metadata.providerGenerationId,
  });

  if (!options.onUsage || !options.usageContext) return;
  const record: AgentUsageRecord = {
    callId: crypto.randomUUID(),
    model: metadata.model,
    iteration: metadata.iteration,
    providerGenerationId: metadata.providerGenerationId,
    usage,
    context: options.usageContext,
    durationMs: metadata.durationMs,
    finishReason: metadata.finishReason,
    recordedAt: new Date().toISOString(),
  };
  await Promise.resolve(options.onUsage(record)).catch((error: unknown) => {
    console.error(JSON.stringify({
      service: "doxa-agent",
      eventType: "usage_sink_failed",
      callId: record.callId,
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}

async function runLegacy(options: AgentOptions, userMessage: string): Promise<RunResult> {
  const {
    provider,
    systemPrompt,
    tools,
    responseFormat,
    maxSteps = DEFAULT_MAX_STEPS,
    temperature,
    maxTokens,
    model,
    maxToolOutputChars = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    maxSingleToolOutputChars = DEFAULT_MAX_SINGLE_TOOL_OUTPUT_CHARS,
    abortController,
  } = options;
  const loopState = createAgentLoopState(options.loopPolicy, maxSteps);

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const toolDefs = tools && tools.length > 0 ? toToolDefinitions(tools) : undefined;

  let steps = 0;
  let usage: TokenUsage = emptyUsage();
  let retainedToolOutputChars = 0;
  let finishReason: string | undefined;

  while (steps < maxSteps) {
    abortController?.signal.throwIfAborted();
    steps++;
    const iterationRequest = createLegacyIterationRequest(
      messages,
      loopState,
      steps,
    );

    const requestStartedAt = Date.now();
    let response: ChatResponse;
    try {
      response = await provider.chat({
        model,
        messages: iterationRequest.messages,
        tools:
          iterationRequest.terminal || responseFormat === "json"
            ? undefined
            : toolDefs,
        responseFormat,
        temperature,
        maxTokens,
        abortController,
      });
    } catch (error) {
      const requestEndedAt = Date.now();
      await emitAgentSpan(options.onSpan, modelSpan(
        options,
        {
          startedAt: requestStartedAt,
          endedAt: requestEndedAt,
          durationMs: Math.max(0, requestEndedAt - requestStartedAt),
        },
        false,
      ));
      throw error;
    }
    const requestEndedAt = Date.now();
    const modelDurationMs = Math.max(0, requestEndedAt - requestStartedAt);
    await emitAgentSpan(options.onSpan, modelSpan(options, {
      startedAt: requestStartedAt,
      endedAt: requestEndedAt,
      durationMs: modelDurationMs,
    }, true));
    if (response.usage) {
      usage = addUsage(usage, response.usage);
      await emitUsage(options, response.usage, {
        iteration: steps,
        model: response.model ?? model ?? provider.config.model,
        providerGenerationId: response.id,
        durationMs: modelDurationMs,
        finishReason: response.finishReason,
      });
    }
    finishReason = response.finishReason;

    const assistantMsg = response.message;
    messages.push(assistantMsg);

    // A response cut off at the token limit can end inside a tool call, so
    // it ends the loop with its text instead of running that call.
    if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0 || finishReason === "length") {
      return {
        text: assistantMsg.content || "",
        messages,
        steps,
        usage,
        finishReason,
        loop: classifyAgentLoop(
          loopState,
          finishReason,
          assistantMsg.content ?? "",
          steps,
        ),
      };
    }

    if (iterationRequest.terminal) {
      return {
        text: assistantMsg.content ?? "",
        messages,
        steps,
        usage,
        finishReason,
        loop: classifyAgentLoop(
          loopState,
          finishReason,
          assistantMsg.content ?? "",
          steps,
        ),
      };
    }

    if (tools) {
      for (const tc of assistantMsg.toolCalls) {
        const observation = observeToolCall(
          loopState,
          tc.function.name,
          parseToolArguments(tc.function.arguments),
        );
        if (observation.blocked) {
          messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: REPEATED_TOOL_CALL_RESULT,
          });
          continue;
        }

        const output = await executeTool(
          tools,
          tc.function.name,
          tc.function.arguments,
          {
            abortSignal: abortController?.signal,
            onSpan: options.onSpan,
          },
        );
        const remainingBudget = Math.max(0, maxToolOutputChars - retainedToolOutputChars);
        const allowedChars = Math.min(maxSingleToolOutputChars, remainingBudget);
        const retainedOutput = truncateToolOutput(output, allowedChars);
        retainedToolOutputChars += retainedOutput.length;
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: retainedOutput,
        });
      }
    }
  }

  const lastAssistant = getLastAssistantMessage(messages);
  return {
    text: lastAssistant?.content || "",
    messages,
    steps,
    usage,
    finishReason,
    loop: classifyAgentLoop(
      loopState,
      finishReason,
      lastAssistant?.content ?? "",
      steps,
    ),
  };
}

function truncateToolOutput(output: string, allowedChars: number): string {
  if (allowedChars <= 0) {
    return "Tool output omitted because the per-run tool context budget is exhausted. Use the information already gathered to write the page.";
  }
  if (output.length <= allowedChars) return output;
  // A cut inside an untrusted-data block closes the block before the notice.
  return truncateUntrustedAwareOutput(output, allowedChars, "... (tool output truncated by per-run context budget; narrow future tool calls)");
}

async function* streamLegacy(
  options: AgentOptions,
  userMessage: string
): AsyncGenerator<StreamEvent> {
  const { provider, systemPrompt, tools, responseFormat, maxSteps = DEFAULT_MAX_STEPS, temperature, maxTokens, model, abortController } = options;
  const loopState = createAgentLoopState(options.loopPolicy, maxSteps);

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const toolDefs = tools && tools.length > 0 ? toToolDefinitions(tools) : undefined;

  let steps = 0;

  while (steps < maxSteps) {
    abortController?.signal.throwIfAborted();
    steps++;
    const iterationRequest = createLegacyIterationRequest(
      messages,
      loopState,
      steps,
    );

    let assistantMsg: AssistantMessage | null = null;

    const requestStartedAt = Date.now();
    try {
      for await (const event of provider.chatStream({
        model,
        messages: iterationRequest.messages,
        tools:
          iterationRequest.terminal || responseFormat === "json"
            ? undefined
            : toolDefs,
        responseFormat,
        temperature,
        maxTokens,
        abortController,
      })) {
        switch (event.type) {
          case "text_delta":
            yield { type: "text_delta", text: event.text };
            break;

          case "tool_call_start":
            yield { type: "tool_call_start", id: event.id, name: event.name };
            break;

          case "tool_call_delta":
            yield { type: "tool_call_delta", id: "", arguments: event.arguments };
            break;

          case "done":
            assistantMsg = event.message;
            yield { type: "message_complete", message: event.message };
            break;
        }
      }
    } catch (error) {
      const requestEndedAt = Date.now();
      await emitAgentSpan(options.onSpan, modelSpan(
        options,
        {
          startedAt: requestStartedAt,
          endedAt: requestEndedAt,
          durationMs: Math.max(0, requestEndedAt - requestStartedAt),
        },
        false,
      ));
      throw error;
    }
    const requestEndedAt = Date.now();
    await emitAgentSpan(options.onSpan, modelSpan(options, {
      startedAt: requestStartedAt,
      endedAt: requestEndedAt,
      durationMs: Math.max(0, requestEndedAt - requestStartedAt),
    }, true));

    if (!assistantMsg) {
      break;
    }

    messages.push(assistantMsg);

    if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) {
      yield { type: "done", text: assistantMsg.content || "" };
      return;
    }

    if (iterationRequest.terminal) {
      yield { type: "done", text: assistantMsg.content ?? "" };
      return;
    }

    if (tools) {
      for (const tc of assistantMsg.toolCalls) {
        yield { type: "tool_call_end", id: tc.id };

        const observation = observeToolCall(
          loopState,
          tc.function.name,
          parseToolArguments(tc.function.arguments),
        );
        if (observation.blocked) {
          yield {
            type: "tool_result",
            id: tc.id,
            name: tc.function.name,
            output: REPEATED_TOOL_CALL_RESULT,
          };
          messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: REPEATED_TOOL_CALL_RESULT,
          });
          continue;
        }

        const output = await executeTool(
          tools,
          tc.function.name,
          tc.function.arguments,
          {
            abortSignal: abortController?.signal,
            onSpan: options.onSpan,
          },
        );

        yield { type: "tool_result", id: tc.id, name: tc.function.name, output };

        messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: output,
        });
      }
    }
  }

  const lastAssistant = getLastAssistantMessage(messages);
  yield { type: "done", text: lastAssistant?.content || "" };
}
