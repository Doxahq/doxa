import type { ChatMiddlewareConfig, ChatMiddlewareContext, ModelMessage } from "@tanstack/ai";
import { describe, expect, test } from "vitest";

import { createProvider, priceTokenUsage } from "../src/core";
import { getTanStackProviderRuntime } from "../src/core/provider";
import { anthropicModelPrice } from "../src/core/providers/anthropic-pricing";
import {
  anthropicPromptCache,
  markNewestMessage,
} from "../src/core/providers/anthropic-prompt-cache";
import type { PromptCacheSetting } from "../src/core";

const policy = { ttl: "5m" as const };
const marker = { cache_control: { type: "ephemeral", ttl: "5m" } };

function runtimeFor(name: "anthropic" | "openrouter", promptCache?: PromptCacheSetting) {
  const provider = createProvider({
    name,
    baseUrl: "https://example.test",
    apiKey: "test-key",
    model: name === "anthropic" ? "claude-haiku-5-5" : "anthropic/claude-haiku-5.5",
    promptCache,
  });
  const runtime = getTanStackProviderRuntime(provider);
  if (!runtime) throw new Error("Expected a TanStack runtime.");
  return runtime;
}

function contextFor(
  phase: "init" | "beforeModel",
  hasTools: boolean,
): ChatMiddlewareContext {
  return { phase, hasTools } as unknown as ChatMiddlewareContext;
}

describe("Anthropic moving cache marker", () => {
  const conversation: ModelMessage[] = [
    { role: "user", content: "Write the page." },
    { role: "assistant", content: null, toolCalls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", toolCallId: "t1", content: "file contents" },
  ];

  test("marks only the newest tool or user message", () => {
    const marked = markNewestMessage(conversation, policy);

    expect(marked[0]).toEqual(conversation[0]);
    expect(marked[2]).toEqual({
      role: "tool",
      toolCallId: "t1",
      content: [{ type: "text", content: "file contents", metadata: marker }],
    });
  });

  test("moves the marker and gives the old message its plain text back", () => {
    const first = markNewestMessage(conversation, policy);
    const next = markNewestMessage([
      ...first,
      { role: "assistant", content: "Checking one more file." },
      { role: "user", content: "Continue." },
    ], policy);

    expect(next[2]).toEqual(conversation[2]);
    expect(next.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", content: "Continue.", metadata: marker }],
    });
  });

  test("leaves content that it did not make untouched", () => {
    const parts: ModelMessage = {
      role: "user",
      content: [{ type: "text", content: "Already in parts." }],
    };
    expect(markNewestMessage([parts], policy)).toEqual([parts]);
  });

  test("runs only before a model call of an agent loop", async () => {
    const middleware = anthropicPromptCache.middleware(policy);
    const config = { messages: conversation } as ChatMiddlewareConfig;

    expect(await middleware.onConfig?.(contextFor("init", true), config)).toBeUndefined();
    expect(await middleware.onConfig?.(contextFor("beforeModel", false), config)).toBeUndefined();
    const result = await middleware.onConfig?.(contextFor("beforeModel", true), config);
    expect(result && "messages" in result ? result.messages?.at(-1)?.content : undefined)
      .toEqual([{ type: "text", content: "file contents", metadata: marker }]);
  });
});

describe("provider prompt cache capability", () => {
  test("Anthropic marks the end of the system prompt with the policy lifetime", () => {
    expect(runtimeFor("anthropic").systemPrompts("Rules")).toEqual([
      { content: "Rules", metadata: marker },
    ]);
    expect(runtimeFor("anthropic", { ttl: "1h" }).systemPrompts("Rules")).toEqual([
      { content: "Rules", metadata: { cache_control: { type: "ephemeral", ttl: "1h" } } },
    ]);
    expect(runtimeFor("anthropic").middleware()).toHaveLength(1);
  });

  test("caching can be turned off", () => {
    const runtime = runtimeFor("anthropic", false);
    expect(runtime.systemPrompts("Rules")).toEqual(["Rules"]);
    expect(runtime.middleware()).toEqual([]);
  });

  test("a provider without the capability sends plain prompts", () => {
    const runtime = runtimeFor("openrouter");
    expect(runtime.systemPrompts("Rules")).toEqual(["Rules"]);
    expect(runtime.middleware()).toEqual([]);
  });
});

describe("usage and cost", () => {
  test("Anthropic usage counts cache tokens in the prompt and gets a list-price cost", () => {
    const usage = runtimeFor("anthropic").finishUsage("claude-sonnet-5-5", {
      promptTokens: 1_000,
      completionTokens: 500,
      totalTokens: 1_500,
      cachedTokens: 8_000,
      cacheWriteTokens: 1_000,
    });

    expect(usage.promptTokens).toBe(10_000);
    expect(usage.totalTokens).toBe(10_500);
    // 1k input at $2, 8k reads at $0.10, 1k 5-minute writes at $2.50, 500 output at $10.
    expect(usage.promptCost).toBeCloseTo(0.002 + 0.0008 + 0.0025, 12);
    expect(usage.completionCost).toBeCloseTo(0.005, 12);
    expect(usage.cost).toBeCloseTo(0.0103, 12);
  });

  test("a cost that the provider sent stays", () => {
    const usage = runtimeFor("openrouter").finishUsage("anthropic/claude-haiku-5.5", {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cost: 0.42,
    });
    expect(usage.cost).toBe(0.42);
  });

  test("an unknown model keeps an unknown cost", () => {
    const usage = runtimeFor("anthropic").finishUsage("claude-unknown-9", {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
    });
    expect(usage.cost).toBeUndefined();
  });

  test("Haiku 5.5 uses its higher prices for a prompt over 100k tokens", () => {
    const price = anthropicModelPrice("claude-haiku-5-5")!;
    const short = priceTokenUsage(price, { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000 }, "5m");
    const long = priceTokenUsage(price, { promptTokens: 100_001, completionTokens: 0, totalTokens: 100_001 }, "5m");

    expect(short.cost).toBeCloseTo(0.01, 12);
    expect(long.cost).toBeCloseTo((100_001 * 0.5) / 1_000_000, 12);
  });

  test("cache writes take the price of the policy lifetime", () => {
    const price = anthropicModelPrice("claude-sonnet-5-5")!;
    const usage = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(priceTokenUsage(price, usage, "5m").cost).toBeCloseTo(2.5, 12);
    expect(priceTokenUsage(price, usage, "1h").cost).toBeCloseTo(4, 12);
  });

  test("price lookup matches dated snapshots but not a longer model name", () => {
    expect(anthropicModelPrice("claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(anthropicModelPrice("claude-sonnet-5-5")?.cacheRead).toBe(0.1);
    expect(anthropicModelPrice("claude-sonnet-5")?.cacheRead).toBe(0.2);
    expect(anthropicModelPrice("claude-sonnet-50")).toBeUndefined();
  });
});

describe("Anthropic request body", () => {
  test("the installed adapter sends both markers to the API", () => {
    const adapter = runtimeFor("anthropic").createAdapter("claude-haiku-5-5") as unknown as {
      mapCommonOptionsToAnthropic(options: Record<string, unknown>): {
        system?: unknown;
        messages: Array<{ role: string; content: unknown }>;
      };
    };
    const logger = { errors: () => undefined, request: () => undefined };
    const messages = markNewestMessage([
      { role: "user", content: "Write the page." },
      { role: "assistant", content: null, toolCalls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", toolCallId: "t1", content: "file contents" },
    ], policy);

    const body = adapter.mapCommonOptionsToAnthropic({
      model: "claude-haiku-5-5",
      messages,
      systemPrompts: anthropicPromptCache.systemPrompts("Rules", policy),
      modelOptions: { max_tokens: 100 },
      logger,
    });

    expect(body.system).toEqual([
      { type: "text", text: "Rules", cache_control: marker.cache_control },
    ]);
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "file contents", cache_control: marker.cache_control }],
      }],
    });
  });
});

describe("prompt cache warm-up", () => {
  test("only a caching provider asks pages to wait for the first call", async () => {
    const { providerCachesPrompts } = await import("../src/core");
    const cached = createProvider({ name: "anthropic", baseUrl: "https://example.test", apiKey: "k", model: "claude-haiku-5-5" });
    const uncached = createProvider({ name: "anthropic", baseUrl: "https://example.test", apiKey: "k", model: "claude-haiku-5-5", promptCache: false });
    const openRouter = createProvider({ name: "openrouter", baseUrl: "https://example.test", apiKey: "k", model: "a/b" });

    expect(providerCachesPrompts(cached)).toBe(true);
    expect(providerCachesPrompts(uncached)).toBe(false);
    expect(providerCachesPrompts(openRouter)).toBe(false);
  });
});

describe("cached prompt prefixes", () => {
  test("the exploration system prompt does not contain the job's workspace path", async () => {
    const { prompts } = await import("../src/doxa-agent/prompts");
    const prompt = prompts.buildExplorationPrompt({ cwd: "/workspaces/job-123/source/checkout" });
    expect(prompt.system).not.toContain("/workspaces/job-123");
    expect(prompt.user).toContain("/workspaces/job-123/source/checkout");
  });
});
