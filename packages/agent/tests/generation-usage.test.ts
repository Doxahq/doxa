import { describe, expect, test } from "vitest";
import { run } from "../src";
import type {
  AgentUsageRecord,
  ChatResponse,
  Provider,
} from "../src";

function provider(model: string, usage: ChatResponse["usage"]): Provider {
  return {
    config: {
      baseUrl: "https://example.test",
      apiKey: "test",
      model,
    },
    chat: async () => ({
      id: `${model}-generation`,
      model,
      message: { role: "assistant", content: "done" },
      finishReason: "stop",
      usage,
    }),
    chatStream: async function* () {
      throw new Error("not used");
    },
  };
}

describe("request-scoped generation usage", () => {
  test("keeps concurrent generation callbacks isolated", async () => {
    const first: AgentUsageRecord[] = [];
    const second: AgentUsageRecord[] = [];

    await Promise.all([
      run({
        provider: provider("planner", {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          cost: 0.12,
        }),
        systemPrompt: "Analyze.",
        usageContext: { operation: "analysis", attempt: 1 },
        onUsage: async (record) => {
          await Promise.resolve();
          first.push(record);
        },
      }, "Go."),
      run({
        provider: provider("writer", {
          promptTokens: 20,
          completionTokens: 5,
          totalTokens: 25,
          cachedTokens: 8,
          reasoningTokens: 3,
          upstreamCost: 0.2,
        }),
        systemPrompt: "Write.",
        usageContext: {
          operation: "page_write",
          pageId: "overview",
          pageTitle: "Overview",
          pageRetry: 1,
          attempt: 2,
        },
        onUsage: (record) => {
          second.push(record);
        },
      }, "Go."),
    ]);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      model: "planner",
      iteration: 1,
      context: { operation: "analysis", attempt: 1 },
      usage: { totalTokens: 12, cost: 0.12 },
    });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      model: "writer",
      iteration: 1,
      context: {
        operation: "page_write",
        pageId: "overview",
        pageRetry: 1,
        attempt: 2,
      },
      usage: {
        totalTokens: 25,
        cachedTokens: 8,
        reasoningTokens: 3,
        upstreamCost: 0.2,
      },
    });
    expect(first[0]?.callId).not.toBe(second[0]?.callId);
  });

  test("counts each actual legacy provider retry as a distinct call", async () => {
    const records: AgentUsageRecord[] = [];
    let calls = 0;
    const retryingProvider: Provider = {
      ...provider("writer", undefined),
      chat: async () => {
        calls++;
        return calls === 1
          ? {
              id: "call-1",
              model: "writer",
              message: {
                role: "assistant",
                content: null,
                toolCalls: [{
                  id: "tool-1",
                  type: "function",
                  function: { name: "missing", arguments: "{}" },
                }],
              },
              usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
            }
          : {
              id: "call-2",
              model: "writer",
              message: { role: "assistant", content: "done" },
              finishReason: "stop",
              usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
            };
      },
    };

    await run({
      provider: retryingProvider,
      systemPrompt: "Write.",
      tools: [],
      usageContext: {
        operation: "page_write",
        pageId: "overview",
        pageTitle: "Overview",
        pageRetry: 0,
        attempt: 1,
      },
      onUsage: (record) => {
        records.push(record);
      },
    }, "Go.");

    expect(records.map((record) => record.providerGenerationId)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(new Set(records.map((record) => record.callId))).toHaveLength(2);
  });
});
