import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";

const chatMock = vi.hoisted(() => vi.fn());
const createOpenRouterTextMock = vi.hoisted(() =>
  vi.fn((model: string, apiKey: string, config: Record<string, unknown>) => ({
    kind: "text",
    name: "openrouter",
    model,
    apiKey,
    config,
  })),
);

vi.mock("@tanstack/ai-openrouter", () => ({
  createOpenRouterText: createOpenRouterTextMock,
}));

vi.mock("@tanstack/ai", () => ({
  chat: chatMock,
  combineStrategies: (strategies: unknown[]) => ({ type: "combined", strategies }),
  maxIterations: (max: number) => ({ type: "maxIterations", max }),
  untilFinishReason: (reasons: string[]) => ({ type: "untilFinishReason", reasons }),
  toolDefinition: (config: Record<string, unknown>) => ({
    ...config,
    __toolSide: "definition",
    server: (execute: (args: unknown) => unknown) => ({
      ...config,
      __toolSide: "server",
      execute,
    }),
  }),
}));

import {
  captureUsage,
  defineTool,
  openrouter,
  run,
  suggestStructure,
  stream,
} from "../src";
import type {
  AgentSpanRecord,
  AgentUsageRecord,
  ChatRequest,
  ChatResponse,
  Provider,
  StreamEvent,
} from "../src";
import { generateStructureWithRetry } from "../src/doxa-agent/structure-runner";
import { prompts } from "../src/doxa-agent/prompts";
import { analysisFixture } from "./fixtures";

function setChatStream(
  chunks: unknown[],
  before?: (options: any) => Promise<void> | void,
): void {
  chatMock.mockImplementation((options: any) => ({
    [Symbol.asyncIterator]: async function* () {
      await before?.(options);
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  }));
}

function createProvider(): Provider {
  return openrouter({ apiKey: "test-key", model: "test/model" });
}

interface DeadlineMiddlewareForTest {
  name?: string;
  onIteration(
    context: { iteration: number },
    info: { iteration: number; messageId: string },
  ): Promise<void> | void;
  onChunk(
    context: { iteration: number },
    chunk: { type: string },
  ): Promise<void> | void;
}

function useStructureChatResponses(
  responses: readonly string[],
  timerDelaysByAttempt: Array<Array<number | undefined>>,
): void {
  let attempt = 0;
  chatMock.mockImplementation((options: {
    middleware: DeadlineMiddlewareForTest[];
  }) => ({
    [Symbol.asyncIterator]: async function* () {
      const deadline = options.middleware.find(
        (candidate) => candidate.name === "doxa-model-call-deadline",
      );
      if (!deadline) throw new Error("Model-call deadline middleware is missing.");

      const timerCallStart = vi.mocked(setTimeout).mock.calls.length;
      await deadline.onIteration(
        { iteration: 0 },
        { iteration: 0, messageId: `msg_${attempt + 1}` },
      );
      timerDelaysByAttempt.push(
        vi.mocked(setTimeout).mock.calls
          .slice(timerCallStart)
          .map((call) => call[1]),
      );

      const content = responses[Math.min(attempt, responses.length - 1)] ?? "";
      attempt += 1;
      yield { type: "TEXT_MESSAGE_CONTENT", delta: content };
      await deadline.onChunk({ iteration: 0 }, { type: "RUN_FINISHED" });
      yield { type: "RUN_FINISHED", finishReason: "stop" };
    },
  }));
}

const validStructureResponse = JSON.stringify({
  sections: [
    {
      id: "default",
      title: "Documentation",
      default: true,
      pages: [
        {
          id: "overview",
          title: "Overview",
          description:
            "Project overview covering goals, audience, and high-level capabilities in clear terms.",
        },
      ],
    },
  ],
});

describe("TanStack runtime bridge", () => {
  beforeEach(() => {
    vi.useRealTimers();
    chatMock.mockReset();
    createOpenRouterTextMock.mockClear();
  });

  test("keeps the text of a response that stopped at the token limit", async () => {
    setChatStream([
      { type: "TEXT_MESSAGE_CONTENT", delta: "# Quickstart\n\nInstall the SDK and" },
      {
        type: "RUN_ERROR",
        message: "The response was cut off because the maximum token limit was reached.",
        code: "max_tokens",
      },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ]);

    const result = await run(
      { provider: createProvider(), systemPrompt: "Write the page.", model: "custom/model" },
      "Write.",
    );

    expect(result.text).toBe("# Quickstart\n\nInstall the SDK and");
    expect(result.finishReason).toBe("length");
  });

  test("routes JSON response mode through TanStack without tools", async () => {
    const tool = defineTool({
      name: "Read",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async () => "file",
    });
    setChatStream([
      { type: "TEXT_MESSAGE_CONTENT", delta: '{"ok":true}' },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ]);

    const result = await run(
      {
        provider: createProvider(),
        systemPrompt: "Return JSON.",
        tools: [tool],
        responseFormat: "json",
        model: "custom/model",
      },
      "Analyze.",
    );

    expect(result.text).toBe('{"ok":true}');
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(chatMock.mock.calls[0]?.[0]).toMatchObject({
      systemPrompts: ["Return JSON."],
      messages: [{ role: "user", content: "Analyze." }],
      tools: undefined,
      modelOptions: {
        responseFormat: { type: "json_object" },
      },
    });
    expect(createOpenRouterTextMock).toHaveBeenCalledWith(
      "custom/model",
      "test-key",
      { serverURL: "https://openrouter.ai/api/v1", retryConfig: { strategy: "none" } },
    );
  });

  test("converts Doxa tools to TanStack server tools and truncates output", async () => {
    const longOutput = "x".repeat(40);
    let toolResult = "";
    const tool = defineTool({
      name: "Read",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => `${path}:${longOutput}`,
    });
    setChatStream(
      [
        { type: "TEXT_MESSAGE_CONTENT", delta: "done" },
        { type: "RUN_FINISHED", finishReason: "stop" },
      ],
      async (options) => {
        toolResult = await options.tools[0].execute({ path: "src/index.ts" });
      },
    );

    await run(
      {
        provider: createProvider(),
        systemPrompt: "Use tools.",
        tools: [tool],
        maxToolOutputChars: 18,
        maxSingleToolOutputChars: 18,
      },
      "Read.",
    );

    expect(toolResult).toContain("src/index.ts:");
    expect(toolResult).toContain("tool output truncated");
    expect(toolResult.length).toBeGreaterThan(18);
  });

  test("returns only the final assistant iteration after tool use", async () => {
    setChatStream([
      {
        type: "TEXT_MESSAGE_START",
        messageId: "inspection",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "inspection",
        delta: "I'll inspect the repository before writing.",
      },
      {
        type: "TEXT_MESSAGE_END",
        messageId: "inspection",
      },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call_1",
        toolCallName: "Read",
      },
      {
        type: "TOOL_CALL_END",
        toolCallId: "call_1",
        toolCallName: "Read",
        result: "repository evidence",
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "final",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "final",
        delta: "---\ntitle: Overview\n---\n\n## Overview\n\nFinal documentation.",
      },
      {
        type: "TEXT_MESSAGE_END",
        messageId: "final",
      },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ]);

    const result = await run(
      {
        provider: createProvider(),
        systemPrompt: "Use tools, then return the final page.",
        tools: [
          defineTool({
            name: "Read",
            description: "Read repository evidence",
            parameters: z.object({ path: z.string() }),
            execute: async () => "repository evidence",
          }),
        ],
      },
      "Write the overview.",
    );

    expect(result.text).toBe(
      "---\ntitle: Overview\n---\n\n## Overview\n\nFinal documentation.",
    );
    expect(result.text).not.toContain("I'll inspect");
  });

  test("reserves the final iteration for a complete tools-disabled response", async () => {
    const finalPage = [
      "---",
      'title: "Overview"',
      'description: "How the project works."',
      "---",
      "",
      "## Overview",
      "",
      "Complete documentation based on the collected repository evidence.",
    ].join("\n");
    let terminalConfig: unknown;

    setChatStream(
      [
        { type: "TEXT_MESSAGE_CONTENT", delta: finalPage },
        { type: "RUN_FINISHED", finishReason: "stop" },
      ],
      async (options) => {
        const middleware = options.middleware.find(
          (candidate: { name?: string }) =>
            candidate.name === "doxa-agent-loop-policy",
        );
        terminalConfig = await middleware.onConfig(
          { phase: "beforeModel", iteration: 11 },
          {
            messages: [{ role: "user", content: "Write the page." }],
            systemPrompts: ["Write documentation."],
            tools: [{ name: "read" }],
            modelOptions: { temperature: 0.2 },
          },
        );
      },
    );

    const result = await run(
      {
        provider: createProvider(),
        systemPrompt: "Write documentation.",
        tools: [
          defineTool({
            name: "read",
            description: "Read repository evidence",
            parameters: z.object({ path: z.string() }),
            execute: async () => "repository evidence",
          }),
        ],
        maxSteps: 12,
        loopPolicy: {
          finalizationPrompt: "Write the complete page now.",
        },
      },
      "Write the page.",
    );

    expect(terminalConfig).toMatchObject({
      tools: [],
      modelOptions: {
        temperature: 0.2,
        toolChoice: "none",
      },
      messages: [
        { role: "user", content: "Write the page." },
        { role: "user", content: "Write the complete page now." },
      ],
    });
    expect(result.text).toBe(finalPage);
    expect(result.loop?.termination).toBe("forced_finalization");
  });

  test("propagates cancellation to TanStack chat and server tools", async () => {
    const abortController = new AbortController();
    let runtimeAbortController: AbortController | undefined;
    let toolSignal: AbortSignal | undefined;
    const tool = defineTool({
      name: "Read",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async (_args, context?: { abortSignal?: AbortSignal }) => {
        toolSignal = context?.abortSignal;
        return "file";
      },
    });
    setChatStream(
      [
        { type: "TEXT_MESSAGE_CONTENT", delta: "done" },
        { type: "RUN_FINISHED", finishReason: "stop" },
      ],
      async (options) => {
        runtimeAbortController = options.abortController;
        await options.tools[0].execute(
          { path: "src/index.ts" },
          { abortSignal: options.abortController.signal },
        );
      },
    );

    await run(
      {
        provider: createProvider(),
        systemPrompt: "Use tools.",
        tools: [tool],
        abortController,
      },
      "Read.",
    );

    expect(runtimeAbortController).not.toBe(abortController);
    expect(toolSignal).toBe(runtimeAbortController?.signal);
  });

  test("rejects when cancellation ends the TanStack stream without output", async () => {
    const abortController = new AbortController();
    setChatStream([], () => {
      abortController.abort(new Error("generation cancelled"));
    });

    await expect(run(
      {
        provider: createProvider(),
        systemPrompt: "Write.",
        abortController,
      },
      "Write the page.",
    )).rejects.toThrow("generation cancelled");
  });

  test("aborts a hung model call at its own deadline without cancelling the job", async () => {
    vi.useFakeTimers();
    const jobAbortController = new AbortController();
    let modelAbortController: AbortController | undefined;
    setChatStream([], async (options) => {
      modelAbortController = options.abortController;
      const deadline = options.middleware.find(
        (candidate: { name?: string }) =>
          candidate.name === "doxa-model-call-deadline",
      );
      await deadline.onIteration(
        { iteration: 0 },
        { iteration: 0, messageId: "msg_1" },
      );
      await new Promise<void>((_resolve, reject) => {
        options.abortController.signal.addEventListener(
          "abort",
          () => reject(options.abortController.signal.reason),
          { once: true },
        );
      });
    });

    const result = run(
      {
        provider: createProvider(),
        systemPrompt: "Write.",
        abortController: jobAbortController,
        modelCallTimeoutMs: 25,
      },
      "Write the page.",
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: "ModelCallTimeoutError",
      iteration: 1,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(modelAbortController?.signal.aborted).toBe(true);
    expect(jobAbortController.signal.aborted).toBe(false);
  });

  test("keeps a model call alive while the stream continues producing output", async () => {
    vi.useFakeTimers();
    let modelAbortController: AbortController | undefined;
    setChatStream(
      [
        { type: "TEXT_MESSAGE_CONTENT", delta: "done" },
        { type: "RUN_FINISHED", finishReason: "stop" },
      ],
      async (options) => {
        modelAbortController = options.abortController;
        const deadline = options.middleware.find(
          (candidate: { name?: string }) =>
            candidate.name === "doxa-model-call-deadline",
        );
        await deadline.onIteration(
          { iteration: 0 },
          { iteration: 0, messageId: "msg_1" },
        );
        for (let chunk = 0; chunk < 11; chunk += 1) {
          await vi.advanceTimersByTimeAsync(50);
          await deadline.onChunk(
            { iteration: 0 },
            { type: "TEXT_MESSAGE_CONTENT", delta: "." },
          );
        }
      },
    );

    await expect(run(
      {
        provider: createProvider(),
        systemPrompt: "Write.",
        modelCallTimeoutMs: 100,
        modelCallMaxDurationMs: 1_000,
      },
      "Write the page.",
    )).resolves.toMatchObject({ text: "done" });
    expect(modelAbortController?.signal.aborted).toBe(false);
  });

  test("starts the idle timeout again after the most recent chunk", async () => {
    vi.useFakeTimers();
    let modelAbortController: AbortController | undefined;
    setChatStream([], async (options) => {
      modelAbortController = options.abortController;
      const deadline = options.middleware.find(
        (candidate: { name?: string }) =>
          candidate.name === "doxa-model-call-deadline",
      );
      await deadline.onIteration(
        { iteration: 0 },
        { iteration: 0, messageId: "msg_1" },
      );
      await vi.advanceTimersByTimeAsync(50);
      await deadline.onChunk(
        { iteration: 0 },
        { type: "TEXT_MESSAGE_CONTENT", delta: "first" },
      );
      await vi.advanceTimersByTimeAsync(99);
      expect(options.abortController.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      options.abortController.signal.throwIfAborted();
    });

    const result = run(
      {
        provider: createProvider(),
        systemPrompt: "Write.",
        modelCallTimeoutMs: 100,
        modelCallMaxDurationMs: 1_000,
      },
      "Write the page.",
    );

    await expect(result).rejects.toMatchObject({
      name: "ModelCallTimeoutError",
      kind: "idle",
      iteration: 1,
      timeoutMs: 100,
      message: "Model call 1 produced no output for 100ms.",
    });
    expect(modelAbortController?.signal.aborted).toBe(true);
  });

  test("aborts a continuously active stream at the absolute duration ceiling", async () => {
    vi.useFakeTimers();
    setChatStream([], async (options) => {
      const deadline = options.middleware.find(
        (candidate: { name?: string }) =>
          candidate.name === "doxa-model-call-deadline",
      );
      await deadline.onIteration(
        { iteration: 0 },
        { iteration: 0, messageId: "msg_1" },
      );
      for (let chunk = 0; chunk < 5; chunk += 1) {
        await vi.advanceTimersByTimeAsync(50);
        await deadline.onChunk(
          { iteration: 0 },
          { type: "TEXT_MESSAGE_CONTENT", delta: "." },
        );
      }
      options.abortController.signal.throwIfAborted();
    });

    await expect(run(
      {
        provider: createProvider(),
        systemPrompt: "Write.",
        modelCallTimeoutMs: 100,
        modelCallMaxDurationMs: 250,
      },
      "Write the page.",
    )).rejects.toMatchObject({
      name: "ModelCallTimeoutError",
      kind: "max_duration",
      iteration: 1,
      timeoutMs: 250,
      message: "Model call 1 exceeded the 250ms maximum duration.",
    });
  });

  test("resets the deadline for each completed model iteration", async () => {
    vi.useFakeTimers();
    let modelAbortController: AbortController | undefined;
    setChatStream(
      [
        { type: "TEXT_MESSAGE_CONTENT", delta: "done" },
        { type: "RUN_FINISHED", finishReason: "stop" },
      ],
      async (options) => {
        modelAbortController = options.abortController;
        const deadline = options.middleware.find(
          (candidate: { name?: string }) =>
            candidate.name === "doxa-model-call-deadline",
        );
        await deadline.onIteration(
          { iteration: 0 },
          { iteration: 0, messageId: "msg_1" },
        );
        await vi.advanceTimersByTimeAsync(15);
        await deadline.onChunk(
          { iteration: 0 },
          { type: "RUN_FINISHED" },
        );
        await deadline.onIteration(
          { iteration: 1 },
          { iteration: 1, messageId: "msg_2" },
        );
        await vi.advanceTimersByTimeAsync(15);
        await deadline.onChunk(
          { iteration: 1 },
          { type: "RUN_FINISHED" },
        );
      },
    );

    await expect(
      run(
        {
          provider: createProvider(),
          systemPrompt: "Write.",
          modelCallTimeoutMs: 20,
        },
        "Write the page.",
      ),
    ).resolves.toMatchObject({ text: "done" });
    await vi.advanceTimersByTimeAsync(20);
    expect(modelAbortController?.signal.aborted).toBe(false);
  });

  test("cleans up every model-call deadline timer after normal completion", async () => {
    vi.useFakeTimers();
    setChatStream(
      [
        { type: "TEXT_MESSAGE_CONTENT", delta: "done" },
        { type: "RUN_FINISHED", finishReason: "stop" },
      ],
      async (options) => {
        const deadline = options.middleware.find(
          (candidate: { name?: string }) =>
            candidate.name === "doxa-model-call-deadline",
        );
        await deadline.onIteration(
          { iteration: 0 },
          { iteration: 0, messageId: "msg_1" },
        );
      },
    );

    await expect(run(
      {
        provider: createProvider(),
        systemPrompt: "Write.",
        modelCallTimeoutMs: 100,
        modelCallMaxDurationMs: 250,
      },
      "Write the page.",
    )).resolves.toMatchObject({ text: "done" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("threads AgentConfig model-call budgets into structure generation", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "setTimeout");
    const timerDelaysByAttempt: Array<Array<number | undefined>> = [];
    useStructureChatResponses([validStructureResponse], timerDelaysByAttempt);

    await suggestStructure(
      {
        provider: createProvider(),
        cwd: "/repo",
        toolPolicy: "read_only",
        modelCallTimeoutMs: 321,
        modelCallMaxDurationMs: 654,
      },
      {
        analysis: analysisFixture,
        answers: {},
        maxPages: 12,
      },
    );

    expect(timerDelaysByAttempt).toEqual([[321, 654]]);
  });

  test("preserves both model-call budgets through the third structure attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "setTimeout");
    const timerDelaysByAttempt: Array<Array<number | undefined>> = [];
    useStructureChatResponses(
      ["{}", "{}", validStructureResponse],
      timerDelaysByAttempt,
    );

    await generateStructureWithRetry(
      createProvider(),
      {
        analysis: analysisFixture,
        answers: {},
        maxPages: 12,
      },
      undefined,
      1,
      [],
      prompts,
      undefined,
      undefined,
      undefined,
      321,
      654,
    );

    expect(timerDelaysByAttempt).toHaveLength(3);
    expect(timerDelaysByAttempt[2]).toEqual([321, 654]);
  });

  test("does not convert cancellation into a tool result that lets the agent continue", async () => {
    const abortController = new AbortController();
    const tool = defineTool({
      name: "Read",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async () => "file",
    });
    setChatStream([], async (options) => {
      abortController.abort(new Error("request disconnected"));
      await options.tools[0].execute(
        { path: "src/index.ts" },
        { abortSignal: abortController.signal },
      );
    });

    await expect(run(
      {
        provider: createProvider(),
        systemPrompt: "Use tools.",
        tools: [tool],
        abortController,
      },
      "Read.",
    )).rejects.toThrow("request disconnected");
  });

  test("records TanStack usage through Doxa usage subscribers", async () => {
    setChatStream(
      [
        { type: "TEXT_MESSAGE_CONTENT", delta: "done" },
        { type: "RUN_FINISHED", finishReason: "stop" },
      ],
      async (options) => {
        const middleware = options.middleware.find(
          (candidate: { name?: string }) => candidate.name === "doxa-usage",
        );
        await middleware.onIteration(
          { model: "test/model", runId: "run_1" },
          { iteration: 0, messageId: "msg_1" },
        );
        await middleware.onUsage(
          { model: "test/model", runId: "run_1" },
          {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            cost: 0.25,
            costDetails: {
              upstreamCost: 0.24,
              upstreamInputCost: 0.1,
              upstreamOutputCost: 0.15,
            },
            promptTokensDetails: {
              cachedTokens: 4,
              cacheWriteTokens: 2,
            },
            completionTokensDetails: {
              reasoningTokens: 3,
            },
          },
        );
        await middleware.onFinish(
          { model: "test/model", runId: "run_1" },
          { finishReason: "stop", duration: 1, content: "done" },
        );
      },
    );

    const captured = await captureUsage(() =>
      run(
        {
          provider: createProvider(),
          systemPrompt: "Track usage.",
        },
        "Go.",
      ),
    );

    expect(captured.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cost: 0.25,
      promptCost: 0.1,
      completionCost: 0.15,
      upstreamCost: 0.24,
      cachedTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    });
    expect(captured.result.steps).toBe(1);
  });

  test("emits timed model and tool spans for a tool-using run", async () => {
    const spans: AgentSpanRecord[] = [];
    const usageRecords: AgentUsageRecord[] = [];
    const tool = defineTool({
      name: "Read",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => `contents:${path}`,
    });

    setChatStream(
      [
        { type: "TEXT_MESSAGE_CONTENT", delta: "done" },
        { type: "RUN_FINISHED", finishReason: "stop" },
      ],
      async (options) => {
        const usageMiddleware = options.middleware.find(
          (candidate: { name?: string }) => candidate.name === "doxa-usage",
        );
        await usageMiddleware.onIteration(
          { model: "test/model", runId: "run_1" },
          { iteration: 0, messageId: "msg_1" },
        );
        await options.tools[0].execute({ path: "src/index.ts" });
        await usageMiddleware.onUsage(
          { model: "test/model", runId: "run_1", iteration: 0 },
          {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        );
      },
    );

    await run(
      {
        provider: createProvider(),
        systemPrompt: "Use tools.",
        tools: [tool],
        usageContext: { operation: "page_write", pageId: "overview" },
        onUsage: (record) => {
          usageRecords.push(record);
        },
        onSpan: (span) => {
          spans.push(span);
        },
      },
      "Read.",
    );

    expect(spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "model",
        name: "page_write",
        ok: true,
        context: { operation: "page_write", pageId: "overview" },
      }),
      expect.objectContaining({
        kind: "tool",
        name: "Read",
        ok: true,
      }),
    ]));
    expect(spans.every((span) => span.durationMs >= 0)).toBe(true);
    expect(usageRecords).toHaveLength(1);
    expect(usageRecords[0]?.durationMs).toEqual(expect.any(Number));
  });

  test("translates TanStack stream chunks to Doxa stream events", async () => {
    setChatStream([
      { type: "TEXT_MESSAGE_CONTENT", delta: "A" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call_1",
        toolCallName: "Read",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "call_1",
        delta: '{"path":"package.json"}',
      },
      {
        type: "TOOL_CALL_END",
        toolCallId: "call_1",
        toolCallName: "Read",
        result: "package content",
      },
      { type: "TEXT_MESSAGE_CONTENT", delta: "B" },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ]);

    const events: StreamEvent[] = [];
    for await (const event of stream(
      {
        provider: createProvider(),
        systemPrompt: "Stream.",
        tools: [
          defineTool({
            name: "Read",
            description: "Read a file",
            parameters: z.object({ path: z.string() }),
            execute: async () => "unused",
          }),
        ],
      },
      "Go.",
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "tool_result",
      "text_delta",
      "message_complete",
      "done",
    ]);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      id: "call_1",
      name: "Read",
      output: "package content",
    });
    expect(events.at(-1)).toEqual({ type: "done", text: "AB" });
  });

  test("keeps injected non-TanStack providers on the legacy loop", async () => {
    const userPrompts: string[] = [];
    const provider: Provider = {
      config: {
        baseUrl: "https://example.test",
        apiKey: "test",
        model: "fake",
      },
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        userPrompts.push(request.messages.find((message) => message.role === "user")?.content ?? "");
        return {
          message: {
            role: "assistant",
            content: "legacy",
          },
          finishReason: "stop",
        };
      },
      chatStream: async function* () {
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: "unused",
          },
          finishReason: "stop",
        };
      },
    };

    const result = await run(
      {
        provider,
        systemPrompt: "Legacy.",
        responseFormat: "json",
      },
      "Stay compatible.",
    );

    expect(result.text).toBe("legacy");
    expect(userPrompts).toEqual(["Stay compatible."]);
    expect(chatMock).not.toHaveBeenCalled();
  });
});
