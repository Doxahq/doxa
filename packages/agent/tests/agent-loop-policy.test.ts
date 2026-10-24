import { describe, expect, test } from "vitest";
import type { ModelMessage } from "@tanstack/ai";
import {
  createAgentLoopMiddleware,
  classifyAgentLoop,
  createAgentLoopState,
  createTerminalTurnConfig,
  isTerminalIteration,
  observeToolCall,
  parseToolArguments,
} from "../src/core/agent-loop-policy";

const policy = {
  finalizationPrompt: "Write the complete page now.",
  repeatedToolCallLimit: 3,
};

describe("agent loop policy", () => {
  test("reserves only the configured final iteration", () => {
    expect(isTerminalIteration(0, 12)).toBe(false);
    expect(isTerminalIteration(10, 12)).toBe(false);
    expect(isTerminalIteration(11, 12)).toBe(true);
  });

  test("rejects invalid total iteration budgets", () => {
    expect(() => createAgentLoopState(policy, 1)).toThrow(
      "maxSteps must be at least 2 when terminal finalization is enabled",
    );
  });

  test("blocks the third consecutive canonically identical tool call", () => {
    const state = createAgentLoopState(policy, 12);

    expect(
      observeToolCall(state, "read", { path: "src/index.ts", line: 1 }).blocked,
    ).toBe(false);
    expect(
      observeToolCall(state, "read", { line: 1, path: "src/index.ts" }).blocked,
    ).toBe(false);
    expect(
      observeToolCall(state, "read", { path: "src/index.ts", line: 1 }),
    ).toMatchObject({
      blocked: true,
      repeatCount: 3,
    });
  });

  test("resets the repeat count after a different call", () => {
    const state = createAgentLoopState(policy, 12);

    observeToolCall(state, "read", { path: "src/index.ts" });
    observeToolCall(state, "read", { path: "src/index.ts" });
    expect(
      observeToolCall(state, "grep", { pattern: "createApp" }).repeatCount,
    ).toBe(1);
    expect(
      observeToolCall(state, "read", { path: "src/index.ts" }).repeatCount,
    ).toBe(1);
  });

  test("classifies a successful terminal page separately from exhaustion", () => {
    const completed = createAgentLoopState(policy, 12);
    completed.finalizationTriggered = true;

    expect(
      classifyAgentLoop(
        completed,
        "stop",
        "---\ntitle: Overview\n---\n\nBody",
        12,
      ),
    ).toMatchObject({
      termination: "forced_finalization",
      finalizationTriggered: true,
    });

    const exhausted = createAgentLoopState(policy, 12);
    exhausted.finalizationTriggered = true;

    expect(classifyAgentLoop(exhausted, "tool_calls", "", 12)).toMatchObject({
      termination: "agent_loop_exhausted",
    });
  });

  test("removes tools and forces no tool choice before the final model request", () => {
    const state = createAgentLoopState(policy, 12);
    const messages: ModelMessage[] = [
      { role: "user", content: "Write the page." },
    ];
    const config = {
      messages,
      tools: [{ name: "read" }],
      modelOptions: { temperature: 0.2 },
    };

    expect(
      createTerminalTurnConfig(state, "beforeModel", 10, config),
    ).toBeUndefined();

    expect(
      createTerminalTurnConfig(state, "beforeModel", 11, config),
    ).toEqual({
      messages: [
        { role: "user", content: "Write the page." },
        { role: "user", content: "Write the complete page now." },
      ],
      tools: [],
      modelOptions: {
        temperature: 0.2,
        toolChoice: "none",
      },
    });
    expect(state.finalizationTriggered).toBe(true);
  });

  test("provides the TanStack middleware used by the production runtime", () => {
    const middleware = createAgentLoopMiddleware(
      createAgentLoopState(policy, 12),
    );

    expect(middleware.name).toBe("doxa-agent-loop-policy");
    expect(middleware.onConfig).toBeTypeOf("function");
    expect(middleware.onBeforeToolCall).toBeTypeOf("function");
  });

  test("parses valid tool arguments and preserves malformed input", () => {
    expect(parseToolArguments('{"path":"src/index.ts"}')).toEqual({
      path: "src/index.ts",
    });
    expect(parseToolArguments("{not-json")).toBe("{not-json");
  });
});
