import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { describe, expect, test, vi } from "vitest";

import {
  ModelCallError,
  classifyModelCallFailure,
  isRunStoppingModelError,
  retryDelayMs,
  withModelCallRetry,
} from "../src/core";
import { modelCallErrorFromChunk } from "../src/core/model-call-errors";

const runError = (code: string, message: string) =>
  ({ type: "RUN_ERROR", message, code, timestamp: 0 }) as unknown as StreamChunk;
const text = (delta: string) =>
  ({ type: "TEXT_MESSAGE_CONTENT", delta, messageId: "m", timestamp: 0 }) as unknown as StreamChunk;
const started = { type: "RUN_STARTED", runId: "r", timestamp: 0 } as unknown as StreamChunk;

/** An adapter whose calls answer with the given chunk lists, one list per call. */
function scriptedAdapter(calls: StreamChunk[][]) {
  let call = 0;
  const adapter = {
    name: "test",
    model: "test-model",
    chatStream: vi.fn(async function* () {
      const chunks = calls[Math.min(call, calls.length - 1)] ?? [];
      call += 1;
      for (const chunk of chunks) yield chunk;
    }),
  };
  return adapter;
}

async function collect(adapter: AnyTextAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.chatStream({} as Parameters<AnyTextAdapter["chatStream"]>[0])) {
    chunks.push(chunk);
  }
  return chunks;
}

const instant = { sleep: async () => undefined, random: () => 0.5 };
const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 4_000 };

describe("model call error classes", () => {
  test.each([
    [429, "Rate limited", "rate_limited"],
    [529, "Overloaded", "overloaded"],
    [undefined, "overloaded_error: Overloaded", "overloaded"],
    [500, "Internal server error", "server_error"],
    [503, "Service unavailable", "server_error"],
    [408, "Request timeout", "timeout"],
    [400, "prompt is too long", "invalid_request"],
    [413, "Request too large", "too_large"],
    [401, "invalid x-api-key", "auth"],
    [403, "permission denied", "auth"],
    [404, "model: claude-x not found", "model_not_found"],
    [402, "Insufficient credits", "spend_cap"],
    [400, "Your credit balance is too low to access the Anthropic API.", "spend_cap"],
    [429, "You have reached your specified API usage limits.", "spend_cap"],
    [undefined, "Something else", "unknown"],
  ] as const)("status %s with %j is %s", (status, message, expected) => {
    expect(classifyModelCallFailure(status, message)).toBe(expected);
  });

  test("a run-stopping class survives as text in the message", () => {
    const error = modelCallErrorFromChunk({ message: "Your credit balance is too low", code: "400" });
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error.errorClass).toBe("spend_cap");
    expect(error.stopsRun).toBe(true);
    expect(isRunStoppingModelError(new Error(error.message))).toBe(true);
    expect(isRunStoppingModelError(modelCallErrorFromChunk({ message: "Overloaded", code: "529" }))).toBe(false);
  });
});

describe("model call retry", () => {
  test("sends a call that failed before any output again", async () => {
    const adapter = scriptedAdapter([
      [started, runError("529", "Overloaded")],
      [started, text("hello")],
    ]);
    const onRetry = vi.fn();

    const chunks = await collect(withModelCallRetry(adapter as unknown as AnyTextAdapter, policy, { ...instant, onRetry }));

    expect(chunks).toEqual([started, text("hello")]);
    expect(adapter.chatStream).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 500 }));
  });

  test("gives the error to the caller after the last attempt", async () => {
    const adapter = scriptedAdapter([[runError("429", "Rate limited")]]);

    const chunks = await collect(withModelCallRetry(adapter as unknown as AnyTextAdapter, policy, instant));

    expect(adapter.chatStream).toHaveBeenCalledTimes(3);
    expect(chunks).toEqual([runError("429", "Rate limited")]);
  });

  test("never retries a refused request or one that already sent output", async () => {
    const refused = scriptedAdapter([[runError("400", "Your credit balance is too low")]]);
    await collect(withModelCallRetry(refused as unknown as AnyTextAdapter, policy, instant));
    expect(refused.chatStream).toHaveBeenCalledTimes(1);

    const midStream = scriptedAdapter([[text("partial"), runError("529", "Overloaded")]]);
    const chunks = await collect(withModelCallRetry(midStream as unknown as AnyTextAdapter, policy, instant));
    expect(midStream.chatStream).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([text("partial"), runError("529", "Overloaded")]);
  });

  test("keeps every other adapter member", () => {
    const adapter = scriptedAdapter([[]]);
    const wrapped = withModelCallRetry(adapter as unknown as AnyTextAdapter, policy, instant);
    expect(wrapped.name).toBe("test");
    expect(wrapped.model).toBe("test-model");
  });

  test("waits a random share of a capped, doubling delay", () => {
    expect(retryDelayMs(policy, 1, () => 1)).toBe(1_000);
    expect(retryDelayMs(policy, 2, () => 1)).toBe(2_000);
    expect(retryDelayMs(policy, 5, () => 1)).toBe(4_000);
    expect(retryDelayMs(policy, 3, () => 0)).toBe(0);
  });
});
