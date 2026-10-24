/**
 * Core Agent Library - Model call retry
 * The one retry layer for transient provider failures. It wraps a TanStack
 * text adapter and sends a failed request again when the provider refused it
 * before any output, so an agent loop keeps its progress. Once output has
 * started, a failure ends the call and the page-level retry decides.
 */

import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { modelCallErrorFromChunk, type ModelCallErrorClass } from "./model-call-errors";

export interface ModelCallRetryPolicy {
  /** Attempts in total, the first one included. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Four attempts over about half a minute at most: long enough for a rate
 * limit window or a short overload, short enough that a stuck provider
 * hands the page to its own retry and fallback model.
 */
export const DEFAULT_MODEL_CALL_RETRY_POLICY: ModelCallRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 15_000,
};

export interface ModelCallRetryEvent {
  attempt: number;
  delayMs: number;
  errorClass: ModelCallErrorClass;
  reason: string;
}

export interface ModelCallRetryHooks {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (retry: ModelCallRetryEvent) => void;
}

/** Full jitter: a random wait up to the capped exponential delay. */
export function retryDelayMs(
  policy: ModelCallRetryPolicy,
  failedAttempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failedAttempt - 1));
  return Math.round(random() * ceiling);
}

type ChatStream = AnyTextAdapter["chatStream"];
type RunErrorChunk = Extract<StreamChunk, { type: "RUN_ERROR" }>;

function isRunError(chunk: StreamChunk): chunk is RunErrorChunk {
  return chunk.type === "RUN_ERROR";
}

/** Lifecycle chunks that come before any model output. */
function isPreamble(chunk: StreamChunk): boolean {
  return chunk.type === "RUN_STARTED";
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryingChatStream(
  chatStream: ChatStream,
  policy: ModelCallRetryPolicy,
  hooks: ModelCallRetryHooks,
): ChatStream {
  const sleep = hooks.sleep ?? defaultSleep;
  return async function* (options) {
    for (let attempt = 1; ; attempt++) {
      const held: StreamChunk[] = [];
      let streaming = false;
      let retry: Pick<ModelCallRetryEvent, "errorClass" | "reason"> | undefined;
      for await (const chunk of chatStream(options)) {
        if (streaming) {
          yield chunk;
          continue;
        }
        if (isPreamble(chunk)) {
          held.push(chunk);
          continue;
        }
        if (isRunError(chunk) && attempt < policy.maxAttempts) {
          const error = modelCallErrorFromChunk(chunk);
          if (error.retryable) {
            retry = { errorClass: error.errorClass, reason: error.message };
            break;
          }
        }
        streaming = true;
        yield* held;
        yield chunk;
      }
      if (retry === undefined) {
        if (!streaming) yield* held;
        return;
      }
      const delayMs = retryDelayMs(policy, attempt, hooks.random);
      hooks.onRetry?.({ attempt, delayMs, ...retry });
      await sleep(delayMs, options.request?.signal ?? undefined);
    }
  };
}

/**
 * The adapter with retries on its streaming calls. Every other member is the
 * adapter's own, bound to it, so the chat engine sees the same adapter.
 */
export function withModelCallRetry(
  adapter: AnyTextAdapter,
  policy: ModelCallRetryPolicy = DEFAULT_MODEL_CALL_RETRY_POLICY,
  hooks: ModelCallRetryHooks = {},
): AnyTextAdapter {
  const chatStream: ChatStream = (options) => adapter.chatStream(options);
  const retrying = retryingChatStream(chatStream, policy, hooks);
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "chatStream") return retrying;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
