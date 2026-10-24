# Writer Agent-Loop Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Doxa writer run a bounded OpenCode-style agent loop that blocks repeated tool calls and reserves its last iteration for a complete, tools-disabled MDX response instead of accepting an unfinished `tool_calls` turn.

**Architecture:** Keep Doxa's existing fixed `maxSteps: 12` writer budget; do not introduce a soft-limit/hard-limit or progress-extension system because OpenCode does not use one. Add a reusable core loop policy that disables tools and sets `toolChoice: "none"` before the twelfth model request, injects a writer-specific finalization instruction, and classifies failure to produce final text as typed loop exhaustion. Mirror the behavior in the injected-provider legacy loop, block the third consecutive identical tool call, then let the existing server-side page validator and bounded writer retry pipeline remain the final correctness gate.

**Tech Stack:** TypeScript 5.9, TanStack AI 0.42.0, OpenRouter adapter 0.15.10, Vitest 2, Zod 4.

## Global Constraints

- Preserve the writer's existing `maxSteps: 12` total-iteration budget.
- Iterations 1-11 may use tools; iteration 12 is a full model generation with no tools.
- Do not add a dynamic 12-to-30 extension or any model-judged "good progress" mechanism.
- Detect three consecutive calls with the same tool name and canonically equal arguments.
- Never execute the third or later consecutive identical call in hosted generation.
- The terminal turn receives the complete conversation and tool-result history and the normal page output-token budget.
- A terminal response ending in `tool_calls`, producing no page text, or otherwise failing to finish is `agent_loop_exhausted`, not a completed document.
- A terminal response ending in `length` continues through the existing expanded-token retry path.
- The server-side `runPageValidation()` gate remains authoritative even though `validate_page` is unavailable on the terminal turn.
- Apply the same semantics to TanStack-backed production providers and injected legacy providers used by tests.
- Do not change analysis, structure generation, page concurrency, model selection, or Cloudflare workflow retry behavior in this plan.
- Preserve unrelated work already present in the worktree; stage only files named in the current task.

---

## OpenCode Source Findings

Research snapshot: [`anomalyco/opencode@a85d8d23aa297b3051e642c28e3fc79b457fc4bc`](https://github.com/anomalyco/opencode/tree/a85d8d23aa297b3051e642c28e3fc79b457fc4bc).

1. OpenCode does **not** define a global `max_tools` number. Its `steps` setting counts model/agent iterations, and one iteration may contain multiple tool calls.
2. The current primary loop uses `agent.steps ?? Infinity`, so the built-in `build`, `plan`, `general`, and `explore` agents are unlimited unless the user configures `steps`. The number `12` appears in configuration examples and tests, not as a global default. See [`packages/opencode/src/session/prompt.ts`](https://github.com/anomalyco/opencode/blob/a85d8d23aa297b3051e642c28e3fc79b457fc4bc/packages/opencode/src/session/prompt.ts#L1178-L1182).
3. OpenCode does not alternate between a soft budget such as 12 and a hard budget such as 30. Repository-wide searches show no progress-based step extension.
4. OpenCode's newer core runner treats the configured last step as a final response turn: it materializes no tools, passes an empty tool list, sets tool choice to `none`, and injects `MAX_STEPS_PROMPT` before making the model request. It does **not** cut the model off at the boundary. See [`packages/core/src/session/runner/llm.ts`](https://github.com/anomalyco/opencode/blob/a85d8d23aa297b3051e642c28e3fc79b457fc4bc/packages/core/src/session/runner/llm.ts#L202-L214).
5. OpenCode detects a doom loop after three identical recent calls using tool name plus JSON input. Its interactive product asks for permission at that point. Doxa has no person present during hosted page generation, so Doxa will deterministically skip the repeated call and return a recovery result to the model. See [`packages/opencode/src/session/processor.ts`](https://github.com/anomalyco/opencode/blob/a85d8d23aa297b3051e642c28e3fc79b457fc4bc/packages/opencode/src/session/processor.ts#L29-L30) and [`packages/opencode/src/session/processor.ts`](https://github.com/anomalyco/opencode/blob/a85d8d23aa297b3051e642c28e3fc79b457fc4bc/packages/opencode/src/session/processor.ts#L353-L379).
6. Doxa will copy the newer core runner's enforced tools-disabled last turn, not the older primary loop's weaker prompt-only behavior.

### Expected writer sequence

```text
Iterations 1-11
  model can call read/glob/grep/validate_page
  tool results are appended to the same conversation
                  |
                  | natural "stop" with complete page
                  +------------------------------------> validate page
                  |
                  | still requesting tools
                  v
Iteration 12 (terminal)
  append writer finalization instruction
  tools = []
  toolChoice = "none"
  model receives all earlier evidence
  model gets a normal output-token budget
  model writes the complete MDX page
                  |
                  +---- stop + text -------------------> validate page
                  |
                  +---- length ------------------------> expanded-token writer retry
                  |
                  +---- tool_calls / empty ------------> agent_loop_exhausted writer retry
```

The terminal iteration is a new full model request. It does not resume a half-written token stream, but it does receive the complete message and tool-result history, so it can synthesize the entire current page without further repository access.

## File Structure

- Create `packages/agent/src/core/agent-loop-policy.ts`
  - Owns policy types, fixed-step accounting, canonical tool-call fingerprints, repeat tracking, terminal-turn middleware, and final termination classification.
- Create `packages/agent/src/doxa-agent/prompts/system/writer-finalization.ts`
  - Owns the Doxa-specific terminal prompt that requires a complete MDX page.
- Create `packages/agent/tests/agent-loop-policy.test.ts`
  - Unit-tests step boundaries, terminal config transformation, and repeated-call detection without a network provider.
- Modify `packages/agent/src/core/types.ts`
  - Adds the optional loop policy and immutable loop report returned by `run()`.
- Modify `packages/agent/src/core/agent.ts`
  - Installs the policy in TanStack and legacy execution paths and returns a typed loop report.
- Modify `packages/agent/src/core/index.ts`
  - Exports public policy/report types and the exhaustion predicate used by the writer pipeline.
- Modify `packages/agent/src/doxa-agent/prompts/system/index.ts`
  - Exports the writer terminal prompt.
- Modify `packages/agent/src/doxa-agent/writer.ts`
  - Applies the fixed writer policy to tracked and untracked writer entry points and forwards loop reports.
- Modify `packages/agent/src/doxa-agent/writer-pipeline.ts`
  - Treats typed exhaustion as a retryable hard issue rather than a candidate document.
- Modify `packages/agent/src/types.ts`
  - Adds safe loop metadata to writer diagnostics.
- Modify `packages/agent/tests/tanstack-runtime.test.ts`
  - Verifies production-path middleware wiring and terminal response selection.
- Modify `packages/agent/tests/legacy-runtime.test.ts`
  - Verifies injected-provider behavioral parity.
- Modify `packages/agent/tests/writer-repair.test.ts`
  - Verifies writer-local recovery from loop exhaustion.
- Modify `packages/agent/README.md`
  - Documents total-step semantics and the tools-disabled terminal turn.

---

### Task 1: Define the reusable fixed-loop policy contract

**Files:**
- Create: `packages/agent/src/core/agent-loop-policy.ts`
- Create: `packages/agent/tests/agent-loop-policy.test.ts`
- Modify: `packages/agent/src/core/types.ts`
- Modify: `packages/agent/src/core/index.ts`

**Interfaces:**
- Produces: `AgentLoopPolicy`, `AgentLoopReport`, `AgentLoopTermination`
- Produces: `createAgentLoopState(policy, maxSteps)`
- Produces: `observeToolCall(state, name, args)`
- Produces: `isTerminalIteration(iteration, maxSteps)`
- Produces: `classifyAgentLoop(state, finishReason, text, steps)`
- Consumes: existing `stableStringify()` from `packages/agent/src/utils/hash.ts`

- [ ] **Step 1: Write failing policy tests**

Create `packages/agent/tests/agent-loop-policy.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  classifyAgentLoop,
  createAgentLoopState,
  isTerminalIteration,
  observeToolCall,
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

    expect(observeToolCall(state, "read", { path: "src/index.ts", line: 1 }).blocked).toBe(false);
    expect(observeToolCall(state, "read", { line: 1, path: "src/index.ts" }).blocked).toBe(false);
    expect(observeToolCall(state, "read", { path: "src/index.ts", line: 1 })).toMatchObject({
      blocked: true,
      repeatCount: 3,
    });
  });

  test("resets the repeat count after a different call", () => {
    const state = createAgentLoopState(policy, 12);

    observeToolCall(state, "read", { path: "src/index.ts" });
    observeToolCall(state, "read", { path: "src/index.ts" });
    expect(observeToolCall(state, "grep", { pattern: "createApp" }).repeatCount).toBe(1);
    expect(observeToolCall(state, "read", { path: "src/index.ts" }).repeatCount).toBe(1);
  });

  test("classifies a successful terminal page separately from exhaustion", () => {
    const completed = createAgentLoopState(policy, 12);
    completed.finalizationTriggered = true;
    expect(classifyAgentLoop(completed, "stop", "---\ntitle: Overview\n---\n\nBody", 12)).toMatchObject({
      termination: "forced_finalization",
      finalizationTriggered: true,
    });

    const exhausted = createAgentLoopState(policy, 12);
    exhausted.finalizationTriggered = true;
    expect(classifyAgentLoop(exhausted, "tool_calls", "", 12)).toMatchObject({
      termination: "agent_loop_exhausted",
    });
  });
});
```

- [ ] **Step 2: Run the policy tests and verify the module is missing**

Run:

```bash
pnpm --filter @doxahq/agent test -- agent-loop-policy.test.ts
```

Expected: FAIL because `../src/core/agent-loop-policy` does not exist.

- [ ] **Step 3: Add the policy and report types**

Add to `packages/agent/src/core/types.ts`:

```ts
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
  /** Consecutive identical calls allowed before execution is skipped. Default 3. */
  repeatedToolCallLimit?: number;
}

export interface AgentLoopReport {
  termination: AgentLoopTermination;
  maxSteps: number;
  steps: number;
  finalizationTriggered: boolean;
  repeatedToolCallsBlocked: number;
}
```

Extend `AgentOptions`:

```ts
  /** Optional fixed-loop enforcement. maxSteps includes the terminal text-only turn. */
  loopPolicy?: AgentLoopPolicy;
```

Extend `RunResult`:

```ts
  /**
   * Deterministic loop termination and guardrail accounting.
   * Optional for compatibility with embedded consumers that construct
   * RunResult fixtures directly; Doxa's run() implementations always set it.
   */
  loop?: AgentLoopReport;
```

- [ ] **Step 4: Implement the pure loop state and classification**

Create `packages/agent/src/core/agent-loop-policy.ts`:

```ts
import type {
  AgentLoopPolicy,
  AgentLoopReport,
} from "./types";
import { stableStringify } from "../utils/hash";

export const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 3;

export interface AgentLoopState {
  readonly policy?: AgentLoopPolicy;
  readonly maxSteps: number;
  finalizationTriggered: boolean;
  repeatedToolCallsBlocked: number;
  lastToolFingerprint?: string;
  repeatedToolCallCount: number;
}

export function createAgentLoopState(
  policy: AgentLoopPolicy | undefined,
  maxSteps: number,
): AgentLoopState {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error("maxSteps must be a positive integer");
  }
  if (policy && maxSteps < 2) {
    throw new Error("maxSteps must be at least 2 when terminal finalization is enabled");
  }
  if (
    policy?.repeatedToolCallLimit !== undefined &&
    (!Number.isInteger(policy.repeatedToolCallLimit) ||
      policy.repeatedToolCallLimit < 2)
  ) {
    throw new Error("repeatedToolCallLimit must be an integer of at least 2");
  }
  return {
    policy,
    maxSteps,
    finalizationTriggered: false,
    repeatedToolCallsBlocked: 0,
    repeatedToolCallCount: 0,
  };
}

export function isTerminalIteration(iteration: number, maxSteps: number): boolean {
  return iteration >= maxSteps - 1;
}

export function observeToolCall(
  state: AgentLoopState,
  name: string,
  args: unknown,
): { blocked: boolean; repeatCount: number } {
  const fingerprint = `${name}:${stableStringify(args)}`;
  state.repeatedToolCallCount =
    fingerprint === state.lastToolFingerprint
      ? state.repeatedToolCallCount + 1
      : 1;
  state.lastToolFingerprint = fingerprint;

  const limit =
    state.policy?.repeatedToolCallLimit ??
    DEFAULT_REPEATED_TOOL_CALL_LIMIT;
  const blocked = Boolean(state.policy) && state.repeatedToolCallCount >= limit;
  if (blocked) state.repeatedToolCallsBlocked += 1;
  return { blocked, repeatCount: state.repeatedToolCallCount };
}

export function classifyAgentLoop(
  state: AgentLoopState,
  finishReason: string | undefined,
  text: string,
  steps: number,
): AgentLoopReport {
  const terminalFinished =
    finishReason === "stop" && text.trim().length > 0;
  const termination = !state.finalizationTriggered
    ? "natural"
    : terminalFinished
      ? "forced_finalization"
      : "agent_loop_exhausted";

  return {
    termination,
    maxSteps: state.maxSteps,
    steps,
    finalizationTriggered: state.finalizationTriggered,
    repeatedToolCallsBlocked: state.repeatedToolCallsBlocked,
  };
}

export function isAgentLoopExhausted(report: AgentLoopReport): boolean {
  return report.termination === "agent_loop_exhausted";
}
```

- [ ] **Step 5: Export the contracts**

Update `packages/agent/src/core/index.ts`:

```ts
export {
  DEFAULT_REPEATED_TOOL_CALL_LIMIT,
  isAgentLoopExhausted,
} from "./agent-loop-policy";
export type {
  AgentLoopPolicy,
  AgentLoopReport,
  AgentLoopTermination,
} from "./types";
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
pnpm --filter @doxahq/agent test -- agent-loop-policy.test.ts
pnpm --filter @doxahq/agent typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the contract**

```bash
git add packages/agent/src/core/agent-loop-policy.ts packages/agent/src/core/types.ts packages/agent/src/core/index.ts packages/agent/tests/agent-loop-policy.test.ts
git commit -m "feat(agent): define bounded loop policy"
```

---

### Task 2: Enforce the tools-disabled terminal turn in TanStack AI

**Files:**
- Modify: `packages/agent/src/core/agent-loop-policy.ts`
- Modify: `packages/agent/src/core/agent.ts`
- Modify: `packages/agent/tests/agent-loop-policy.test.ts`
- Modify: `packages/agent/tests/tanstack-runtime.test.ts`

**Interfaces:**
- Consumes: `AgentOptions.loopPolicy`, `AgentOptions.maxSteps`
- Produces: `createAgentLoopMiddleware(state): ChatMiddleware`
- Produces: `RunResult.loop`

- [ ] **Step 1: Add failing middleware transformation tests**

Append to `packages/agent/tests/agent-loop-policy.test.ts`:

```ts
import { createAgentLoopMiddleware } from "../src/core/agent-loop-policy";

test("removes tools and forces no tool choice before the final model request", async () => {
  const state = createAgentLoopState(policy, 12);
  const middleware = createAgentLoopMiddleware(state);
  const config = {
    messages: [{ role: "user" as const, content: "Write the page." }],
    systemPrompts: ["You write documentation."],
    tools: [{ name: "read" }] as never[],
    modelOptions: { temperature: 0.2 },
  };

  const unchanged = await middleware.onConfig?.(
    { phase: "beforeModel", iteration: 10 } as never,
    config as never,
  );
  expect(unchanged).toBeUndefined();

  const terminal = await middleware.onConfig?.(
    { phase: "beforeModel", iteration: 11 } as never,
    config as never,
  );
  expect(terminal).toMatchObject({
    tools: [],
    modelOptions: {
      temperature: 0.2,
      toolChoice: "none",
    },
  });
  expect(terminal && "messages" in terminal ? terminal.messages?.at(-1) : undefined).toEqual({
    role: "assistant",
    content: "Write the complete page now.",
  });
  expect(state.finalizationTriggered).toBe(true);
});
```

- [ ] **Step 2: Run the test and verify the export is missing**

Run:

```bash
pnpm --filter @doxahq/agent test -- agent-loop-policy.test.ts
```

Expected: FAIL because `createAgentLoopMiddleware` is not implemented.

- [ ] **Step 3: Implement terminal transformation and doom-loop skipping**

Add to `packages/agent/src/core/agent-loop-policy.ts`:

```ts
import type {
  ChatMiddleware,
  ModelMessage,
} from "@tanstack/ai";

const REPEATED_TOOL_RESULT =
  "Repeated identical tool call blocked by the agent loop policy. " +
  "Do not request the same tool with the same arguments again. " +
  "Use the evidence already collected, narrow the request, or finish the page.";

export function createAgentLoopMiddleware(
  state: AgentLoopState,
): ChatMiddleware {
  return {
    name: "doxa-agent-loop-policy",
    onConfig: (ctx, config) => {
      if (
        !state.policy ||
        ctx.phase !== "beforeModel" ||
        !isTerminalIteration(ctx.iteration, state.maxSteps)
      ) {
        return;
      }

      state.finalizationTriggered = true;
      const finalizationMessage: ModelMessage = {
        role: "assistant",
        content: state.policy.finalizationPrompt,
      };
      return {
        messages: [...config.messages, finalizationMessage],
        tools: [],
        modelOptions: {
          ...config.modelOptions,
          toolChoice: "none",
        },
      };
    },
    onBeforeToolCall: (_ctx, call) => {
      if (!state.policy) return;
      const observation = observeToolCall(
        state,
        call.toolName,
        call.args,
      );
      if (!observation.blocked) return;
      return {
        type: "skip",
        result: REPEATED_TOOL_RESULT,
      };
    },
  };
}
```

Do not make tool arguments part of logs or diagnostics.

- [ ] **Step 4: Install the policy alongside usage middleware**

In `createTanStackChatStream()` in `packages/agent/src/core/agent.ts`, construct one shared state and pass it into both the stream creator and final result:

```ts
const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
const loopState = createAgentLoopState(options.loopPolicy, maxSteps);
```

Change the middleware array:

```ts
middleware: [
  createAgentLoopMiddleware(loopState),
  createDoxaUsageMiddleware(state, options),
],
```

Keep the existing fixed strategy:

```ts
agentLoopStrategy: combineStrategies([
  maxIterations(maxSteps),
  untilFinishReason(["stop"]),
]),
```

Return both the execution state and loop state from the internal stream factory so `runWithTanStack()` can add:

```ts
loop: classifyAgentLoop(
  loopState,
  accumulator.finishReason ?? state.finishReason,
  text,
  state.steps || 1,
),
```

The tools-disabled request occurs *inside* the existing 12 iterations. Do not add a thirteenth call.

- [ ] **Step 5: Add a TanStack bridge regression**

Extend the `@tanstack/ai` mock in `packages/agent/tests/tanstack-runtime.test.ts` only as needed to retain middleware functions. Add a test that:

1. calls `run()` with `maxSteps: 12` and the loop policy;
2. obtains the `doxa-agent-loop-policy` middleware from `chatMock.mock.calls[0][0].middleware`;
3. invokes `onConfig` with iteration 11;
4. asserts `tools: []`, `toolChoice: "none"`, and the finalization message;
5. streams a complete MDX response with `finishReason: "stop"`;
6. asserts `result.loop.termination === "forced_finalization"`.

Use this response:

```ts
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
```

- [ ] **Step 6: Run TanStack tests and typecheck**

Run:

```bash
pnpm --filter @doxahq/agent test -- agent-loop-policy.test.ts tanstack-runtime.test.ts
pnpm --filter @doxahq/agent typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the TanStack path**

```bash
git add packages/agent/src/core/agent-loop-policy.ts packages/agent/src/core/agent.ts packages/agent/tests/agent-loop-policy.test.ts packages/agent/tests/tanstack-runtime.test.ts
git commit -m "feat(agent): reserve terminal text-only turn"
```

---

### Task 3: Give injected legacy providers identical loop semantics

**Files:**
- Modify: `packages/agent/src/core/agent.ts`
- Modify: `packages/agent/tests/legacy-runtime.test.ts`

**Interfaces:**
- Consumes: the same `AgentLoopPolicy`
- Produces: the same `AgentLoopReport`
- Does not change: `Provider`, `ChatRequest`, or test injection APIs

- [ ] **Step 1: Add a failing terminal-turn parity test**

Add a focused `describe("legacy agent loop policy")` block to `packages/agent/tests/legacy-runtime.test.ts`. Use an injected provider that emits one `read` tool call on iterations 1-11 and emits the complete page on iteration 12.

Assertions:

```ts
expect(requests).toHaveLength(12);
expect(requests.slice(0, 11).every((request) => request.tools?.length)).toBe(true);
expect(requests[11]?.tools).toBeUndefined();
expect(requests[11]?.messages.at(-1)).toEqual({
  role: "assistant",
  content: "Write the complete page now.",
});
expect(toolExecutions).toBe(11);
expect(result.text).toBe(finalPage);
expect(result.loop.termination).toBe("forced_finalization");
```

- [ ] **Step 2: Add a failing repeated-call parity test**

Use a provider that asks for the same `read({ path: "src/index.ts" })` call three times, then returns final text after seeing the synthetic blocked result.

Assertions:

```ts
expect(toolExecutions).toBe(2);
expect(requests.at(-1)?.messages).toContainEqual({
  role: "tool",
  toolCallId: "call-3",
  content: expect.stringContaining("Repeated identical tool call blocked"),
});
expect(result.loop.repeatedToolCallsBlocked).toBe(1);
```

- [ ] **Step 3: Run the legacy tests and verify failure**

Run:

```bash
pnpm --filter @doxahq/agent test -- legacy-runtime.test.ts
```

Expected: FAIL because `runLegacy()` still passes tools on every iteration and executes every repeated call.

- [ ] **Step 4: Enforce terminal request construction in `runLegacy()`**

At the beginning of `runLegacy()`:

```ts
const loopState = createAgentLoopState(options.loopPolicy, maxSteps);
```

Inside the loop, before `provider.chat()`:

```ts
const terminal = Boolean(options.loopPolicy) && steps === maxSteps;
if (terminal) loopState.finalizationTriggered = true;
const requestMessages = terminal
  ? [
      ...messages,
      {
        role: "assistant" as const,
        content: options.loopPolicy!.finalizationPrompt,
      },
    ]
  : messages;

const response = await provider.chat({
  model,
  messages: requestMessages,
  tools:
    terminal || responseFormat === "json"
      ? undefined
      : toolDefs,
  responseFormat,
  temperature,
  maxTokens,
  abortController,
});
```

If a terminal response still contains tool calls, do not execute them. Return an empty/partial candidate with an `agent_loop_exhausted` report.

- [ ] **Step 5: Block repeated calls before execution**

Before each `executeTool()` call:

```ts
const observation = observeToolCall(
  loopState,
  tc.function.name,
  parseToolArguments(tc.function.arguments),
);
if (observation.blocked) {
  messages.push({
    role: "tool",
    toolCallId: tc.id,
    content: REPEATED_TOOL_RESULT,
  });
  continue;
}
```

Add and export this helper from
`packages/agent/src/core/agent-loop-policy.ts` so malformed tool arguments
produce a stable fingerprint instead of crashing the loop:

```ts
export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
```

Add these assertions to `packages/agent/tests/agent-loop-policy.test.ts`:

```ts
expect(parseToolArguments('{"path":"src/index.ts"}')).toEqual({
  path: "src/index.ts",
});
expect(parseToolArguments("{not-json")).toBe("{not-json");
```

- [ ] **Step 6: Mirror the same behavior in `streamLegacy()`**

Use the same request builder and repeat observer. Its final yielded `done` event must contain only the terminal page text. Do not emit a false successful `done` page when the terminal provider response requests tools.

- [ ] **Step 7: Return the report on every legacy exit**

Every `RunResult` return in `runLegacy()` must include:

```ts
loop: classifyAgentLoop(
  loopState,
  finishReason,
  assistantMsg.content ?? "",
  steps,
),
```

For callers without `loopPolicy`, classification remains `natural`, preserving behavior.

- [ ] **Step 8: Run tests and typecheck**

Run:

```bash
pnpm --filter @doxahq/agent test -- legacy-runtime.test.ts tanstack-runtime.test.ts agent-loop-policy.test.ts
pnpm --filter @doxahq/agent typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit legacy parity**

```bash
git add packages/agent/src/core/agent.ts packages/agent/tests/legacy-runtime.test.ts
git commit -m "fix(agent): enforce loop policy for injected providers"
```

---

### Task 4: Apply a documentation-specific finalization prompt

**Files:**
- Create: `packages/agent/src/doxa-agent/prompts/system/writer-finalization.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/system/index.ts`
- Modify: `packages/agent/src/doxa-agent/writer.ts`
- Modify: `packages/agent/src/doxa-agent/writer-pipeline.ts`
- Modify: `packages/agent/tests/prompts.test.ts`

**Interfaces:**
- Produces: `WRITER_FINALIZATION_PROMPT`
- Consumes: `AgentOptions.loopPolicy`
- Keeps: `maxSteps: 12`

- [ ] **Step 1: Add a failing prompt-contract test**

Add to `packages/agent/tests/prompts.test.ts`:

```ts
import { WRITER_FINALIZATION_PROMPT } from "../src/doxa-agent/prompts/system";

test("writer finalization requires a complete page without tool commentary", () => {
  expect(WRITER_FINALIZATION_PROMPT).toContain("Tools are disabled");
  expect(WRITER_FINALIZATION_PROMPT).toContain("complete MDX page");
  expect(WRITER_FINALIZATION_PROMPT).toContain("first character");
  expect(WRITER_FINALIZATION_PROMPT).toContain("Do not mention");
  expect(WRITER_FINALIZATION_PROMPT).not.toContain("remaining tasks");
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
pnpm --filter @doxahq/agent test -- prompts.test.ts
```

Expected: FAIL because the constant is missing.

- [ ] **Step 3: Create the terminal writer prompt**

Create `packages/agent/src/doxa-agent/prompts/system/writer-finalization.ts`:

```ts
export const WRITER_FINALIZATION_PROMPT = `CRITICAL — FINAL WRITING TURN

The repository research budget for this page has been reached. Tools are disabled for this turn.

Using only the source evidence, validation feedback, and draft information already present in this conversation, write the COMPLETE MDX documentation page now.

STRICT REQUIREMENTS:
- Return the entire page, not a summary, outline, partial continuation, or progress report.
- The first character of the response must be the first "-" in the opening frontmatter block.
- Include complete frontmatter and a complete, useful body with every necessary section.
- Preserve concrete, source-grounded facts and examples gathered during earlier tool calls.
- Resolve any validation feedback already present in the conversation.
- Do not call or describe tools.
- Do not mention the iteration limit, research budget, disabled tools, or unfinished work.
- Do not include a preamble, closing commentary, or an outer markdown code fence.

This is the final opportunity to produce the page. Spend the full response on the polished documentation page.`;
```

Export it from `packages/agent/src/doxa-agent/prompts/system/index.ts`.

- [ ] **Step 4: Apply the policy to both writer entry points**

First extend `WriterRunResult` in
`packages/agent/src/doxa-agent/writer-pipeline.ts` so loop metadata crosses
the writer boundary without temporary type failures:

```ts
import type { AgentLoopReport } from "../core";

export interface WriterRunResult {
  text: string;
  finishReason?: string;
  loop?: AgentLoopReport;
}
```

In `writeDocPage()`, preserve its existing untracked tools:

```ts
const runResult = await run(
  {
    provider,
    systemPrompt: writerPrompt.system,
    tools: [
      ...readOnlyTools(cwd),
      validatePageTool({
        mdxCompile: writerValidation.mdxCompile,
        timeoutMs: writerValidation.timeoutMs,
        cwd,
      }),
    ],
    maxSteps: 12,
    loopPolicy: {
      finalizationPrompt: WRITER_FINALIZATION_PROMPT,
      repeatedToolCallLimit: 3,
    },
    maxTokens,
    maxToolOutputChars: 32_000,
    maxSingleToolOutputChars: 6_000,
    abortController,
  },
  writerPrompt.user,
);
return {
  text: runResult.text,
  finishReason: runResult.finishReason,
  loop: runResult.loop,
};
```

In `writeDocPageTracked()`, preserve its existing dependency-tracked tools:

```ts
const runResult = await run(
  {
    provider,
    systemPrompt: writerPrompt.system,
    tools: [
      ...trackedTools.tools,
      validatePageTool({
        mdxCompile: writerValidation.mdxCompile,
        timeoutMs: writerValidation.timeoutMs,
        cwd,
      }),
    ],
    maxSteps: 12,
    loopPolicy: {
      finalizationPrompt: WRITER_FINALIZATION_PROMPT,
      repeatedToolCallLimit: 3,
    },
    maxTokens,
    maxToolOutputChars: 32_000,
    maxSingleToolOutputChars: 6_000,
    abortController,
  },
  writerPrompt.user,
);
return {
  text: runResult.text,
  finishReason: runResult.finishReason,
  loop: runResult.loop,
};
```

The terminal turn deliberately omits `validate_page`. The existing server-side `runPageValidation()` call immediately after the model returns performs the same authoritative checks.

- [ ] **Step 5: Run prompt and writer tests**

Run:

```bash
pnpm --filter @doxahq/agent test -- prompts.test.ts writer-repair.test.ts
pnpm --filter @doxahq/agent typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the writer policy**

```bash
git add packages/agent/src/doxa-agent/prompts/system/writer-finalization.ts packages/agent/src/doxa-agent/prompts/system/index.ts packages/agent/src/doxa-agent/writer.ts packages/agent/src/doxa-agent/writer-pipeline.ts packages/agent/tests/prompts.test.ts
git commit -m "feat(agent): finalize writer pages without tools"
```

---

### Task 5: Recover loop exhaustion inside the writer attempt pipeline

**Files:**
- Modify: `packages/agent/src/doxa-agent/writer-pipeline.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/tests/writer-repair.test.ts`

**Interfaces:**
- Consumes: `WriterRunResult.loop?: AgentLoopReport`
- Adds diagnostic fields: `steps`, `loopTermination`, `finalizationTriggered`, `repeatedToolCallsBlocked`
- Converts: `agent_loop_exhausted` into a hard validation-history entry

- [ ] **Step 1: Add failing writer recovery tests**

Add a test in `packages/agent/tests/writer-repair.test.ts` where attempt one returns:

```ts
{
  text: "",
  finishReason: "tool_calls",
  loop: {
    termination: "agent_loop_exhausted",
    maxSteps: 12,
    steps: 12,
    finalizationTriggered: true,
    repeatedToolCallsBlocked: 2,
  },
}
```

Attempt two returns a valid page. Assert:

```ts
expect(runOnce).toHaveBeenCalledTimes(2);
expect(secondRetryHint).toContain("agent loop exhausted");
expect(result.content).toContain("## Overview");
expect(diagnostics).toContainEqual(expect.objectContaining({
  eventType: "writer_model_completed",
  steps: 12,
  loopTermination: "agent_loop_exhausted",
  finalizationTriggered: true,
  repeatedToolCallsBlocked: 2,
}));
```

Add a second test where all attempts exhaust and assert `PageValidationExhaustedError.issues` contains `check: "agentLoopExhausted"`.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
pnpm --filter @doxahq/agent test -- writer-repair.test.ts
```

Expected: FAIL because the pipeline currently treats any non-`length` response as candidate content.

- [ ] **Step 3: Extend writer diagnostics types**

Extend the `writer_model_completed` member in `packages/agent/src/types.ts`:

```ts
      steps?: number;
      loopTermination?: AgentLoopTermination;
      finalizationTriggered?: boolean;
      repeatedToolCallsBlocked?: number;
```

Import `AgentLoopTermination` as a type from `./core`.

- [ ] **Step 4: Record safe loop diagnostics**

After `runOnce()` returns:

```ts
loop = result.loop;
```

Add to `writer_model_completed`:

```ts
steps: loop?.steps,
loopTermination: loop?.termination,
finalizationTriggered: loop?.finalizationTriggered,
repeatedToolCallsBlocked: loop?.repeatedToolCallsBlocked,
```

Do not log tool arguments, tool output, generated page content, or prompt text.

- [ ] **Step 5: Handle token length before generic exhaustion**

Keep the existing `finishReason === "length"` branch before the new exhaustion branch so a terminal page that simply needs more output tokens still uses `WRITER_LENGTH_RETRY_MAX_TOKENS`.

- [ ] **Step 6: Add the loop-exhaustion retry branch**

Immediately after the length branch:

```ts
if (loop?.termination === "agent_loop_exhausted") {
  const reason =
    "Writer agent loop exhausted before producing a complete final page";
  const debugPath = await opts.saveDebug(attempt, rawContent, reason);
  const issue: ContentQualityIssue = {
    check: "agentLoopExhausted",
    severity: "hard",
    message: reason,
    fixInstruction:
      "Use targeted repository reads only when necessary, avoid repeated calls, " +
      "then emit the complete page when asked to finalize.",
  };
  validationHistory.push({
    pageRetry: opts.pageRetry ?? 0,
    attempt,
    maxAttempts: max,
    issues: [issue],
    rawContent,
    debugPath,
    finishReason: "agent_loop_exhausted",
  });
  retryHint = renderValidationHistory(validationHistory);
  candidate.issues = [issue];
  bestCandidate = mergeBest(bestCandidate, candidate);

  opts.onDiagnostic?.({
    eventType: "writer_validation_completed",
    pageTitle: opts.title,
    pageRetry,
    attempt,
    maxAttempts: max,
    durationMs: 0,
    bodyChars: candidate.body.length,
    issueCodes: [issue.check],
    hardIssueCount: 1,
    willRetry: attempt < max,
  });

  if (attempt < max) {
    opts.onWarn?.(
      `Page "${opts.title}" exhausted its agent loop ` +
      `(attempt ${attempt}/${max}), retrying with focused guidance...`,
    );
    continue;
  }
  throw new PageValidationExhaustedError({
    title: opts.title,
    attempts: max,
    issues: [issue],
    failedContent: rawContent,
    validationHistory,
  });
}
```

This retry stays inside the page writer. It must not surface as an uncaught exception that causes Cloudflare Workflows to restart the whole writing stage.

- [ ] **Step 7: Run writer tests and typecheck**

Run:

```bash
pnpm --filter @doxahq/agent test -- writer-repair.test.ts generation-batches.test.ts
pnpm --filter @doxahq/agent typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit writer-local recovery**

```bash
git add packages/agent/src/doxa-agent/writer-pipeline.ts packages/agent/src/types.ts packages/agent/tests/writer-repair.test.ts
git commit -m "fix(agent): retry exhausted writer loops locally"
```

---

### Task 6: Document semantics and run full verification

**Files:**
- Modify: `packages/agent/README.md`
- Verify: all files changed in Tasks 1-5

**Interfaces:**
- Documents: `maxSteps` is total iterations, not tool-call count
- Documents: terminal turn and repeated-call threshold

- [ ] **Step 1: Add the public behavior note**

Add a concise “Writer loop limits” section to `packages/agent/README.md`:

```md
### Writer loop limits

Writer `maxSteps` counts model iterations, not individual tool calls. Doxa
currently configures 12 total writer iterations. When a writer reaches the
boundary, iteration 12 is still executed, but repository and validation tools
are removed and tool choice is forced to `none`. The model receives all prior
tool results and a full output-token budget so it can return the complete MDX
page.

Three consecutive calls with the same tool name and canonical arguments are
treated as a repeated-call loop. The third and later calls are skipped. If the
terminal iteration still does not produce final page text, the result is
`agent_loop_exhausted` and the bounded writer-attempt pipeline retries the page
with focused feedback.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
pnpm --filter @doxahq/agent test -- \
  agent-loop-policy.test.ts \
  tanstack-runtime.test.ts \
  legacy-runtime.test.ts \
  prompts.test.ts \
  writer-repair.test.ts \
  generation-batches.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the entire agent package suite**

Run:

```bash
pnpm --filter @doxahq/agent test
pnpm --filter @doxahq/agent typecheck
pnpm --filter @doxahq/agent build
```

Expected: all commands exit 0.

- [ ] **Step 4: Verify the packaged surface**

Run:

```bash
pnpm --filter @doxahq/agent pack:dry-run
```

Expected: the package contains `dist`, runtime files, README, and package metadata; it does not include debug attempts or repository source.

- [ ] **Step 5: Inspect the focused diff**

Run:

```bash
git status --short
git diff --check
git diff -- \
  packages/agent/src/core/agent-loop-policy.ts \
  packages/agent/src/core/types.ts \
  packages/agent/src/core/agent.ts \
  packages/agent/src/core/index.ts \
  packages/agent/src/doxa-agent/prompts/system/writer-finalization.ts \
  packages/agent/src/doxa-agent/prompts/system/index.ts \
  packages/agent/src/doxa-agent/writer.ts \
  packages/agent/src/doxa-agent/writer-pipeline.ts \
  packages/agent/src/types.ts \
  packages/agent/tests/agent-loop-policy.test.ts \
  packages/agent/tests/tanstack-runtime.test.ts \
  packages/agent/tests/legacy-runtime.test.ts \
  packages/agent/tests/prompts.test.ts \
  packages/agent/tests/writer-repair.test.ts \
  packages/agent/README.md
```

Expected: no whitespace errors; no unrelated Doxabot, database, workflow, model, or dashboard changes.

- [ ] **Step 6: Commit documentation and final verification**

```bash
git add packages/agent/README.md
git commit -m "docs(agent): explain writer loop boundaries"
```

---

## Acceptance Criteria

- A normal writer that returns a complete page before step 12 stops immediately; no extra model call is made.
- A writer still requesting tools at step 11 receives a twelfth model request with no tools and `toolChoice: "none"`.
- The twelfth request sees all prior repository reads, searches, tool results, validation feedback, and the normal output-token allowance.
- The twelfth response is the complete MDX page, not a summary or “remaining work” report.
- A third consecutive identical tool call is not executed.
- Canonically equivalent JSON arguments with different property order count as identical.
- A terminal `stop` response with non-empty text is `forced_finalization`.
- A terminal `tool_calls` response or empty response is `agent_loop_exhausted`.
- A terminal `length` response follows the existing expanded-token retry path.
- Loop exhaustion consumes a bounded writer attempt and does not masquerade as valid page content.
- Tracked and untracked writers use the same policy.
- TanStack and injected legacy providers pass equivalent tests.
- Runtime logs contain counts and termination classification but no prompts, tool arguments, tool output, or generated page content.
- No progress-based 12-to-30 extension is introduced.

## Explicit Non-Goals

- No unlimited hosted writer loops.
- No learned or model-judged progress scoring.
- No adaptive token or iteration budget.
- No human permission UI for hosted doom-loop events.
- No change to analysis/structure agents.
- No change to the page validator's rules.
- No model-default change.
- No Cloudflare deployment or live OpenRouter generation as part of implementation verification.
