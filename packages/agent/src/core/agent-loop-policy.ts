import type {
  ChatMiddleware,
  ChatMiddlewarePhase,
  ModelMessage,
} from "@tanstack/ai";
import { stableStringify } from "../utils/hash";
import type { AgentLoopPolicy, AgentLoopReport } from "./types";

export const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 3;
export const REPEATED_TOOL_CALL_RESULT =
  "Repeated identical tool call blocked by the agent loop policy. " +
  "Do not request the same tool with the same arguments again. " +
  "Use the evidence already collected, narrow the request, or finish the page.";

export interface AgentLoopState {
  readonly policy?: AgentLoopPolicy;
  readonly maxSteps: number;
  finalizationTriggered: boolean;
  repeatedToolCallsBlocked: number;
  lastToolFingerprint?: string;
  repeatedToolCallCount: number;
}

export interface ToolCallObservation {
  blocked: boolean;
  repeatCount: number;
}

interface TerminalTurnConfig<TTool> {
  messages: ModelMessage[];
  tools: TTool[];
  modelOptions?: Record<string, unknown>;
}

export type FinalTurnTools<TTool> = Pick<TerminalTurnConfig<TTool>, "tools" | "modelOptions">;

/** Stops tool calls on the forced final turn. Each provider spells this in its own way. */
export type FinalTurnToolPolicy = <TTool>(turn: FinalTurnTools<TTool>) => FinalTurnTools<TTool>;

/** Removes the tools and asks the model for no tool call (OpenAI-compatible APIs). */
export const withoutToolsOnFinalTurn: FinalTurnToolPolicy = (turn) => ({
  tools: [],
  modelOptions: {
    ...turn.modelOptions,
    toolChoice: "none",
  },
});

export function createAgentLoopState(
  policy: AgentLoopPolicy | undefined,
  maxSteps: number,
): AgentLoopState {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error("maxSteps must be a positive integer");
  }
  if (policy && maxSteps < 2) {
    throw new Error(
      "maxSteps must be at least 2 when terminal finalization is enabled",
    );
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

export function isTerminalIteration(
  iteration: number,
  maxSteps: number,
): boolean {
  return iteration >= maxSteps - 1;
}

export function observeToolCall(
  state: AgentLoopState,
  name: string,
  args: unknown,
): ToolCallObservation {
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
  if (blocked) {
    state.repeatedToolCallsBlocked += 1;
  }

  return { blocked, repeatCount: state.repeatedToolCallCount };
}

export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createTerminalTurnConfig<TTool>(
  state: AgentLoopState,
  phase: ChatMiddlewarePhase,
  iteration: number,
  config: TerminalTurnConfig<TTool>,
  finalTurnToolPolicy: FinalTurnToolPolicy = withoutToolsOnFinalTurn,
): TerminalTurnConfig<TTool> | undefined {
  if (
    !state.policy ||
    phase !== "beforeModel" ||
    !isTerminalIteration(iteration, state.maxSteps)
  ) {
    return undefined;
  }

  state.finalizationTriggered = true;
  // A user turn, not an assistant turn: newer Claude models reject a
  // conversation that ends with an assistant message (prefill).
  return {
    messages: [
      ...config.messages,
      {
        role: "user",
        content: state.policy.finalizationPrompt,
      },
    ],
    ...finalTurnToolPolicy(config),
  };
}

export function createAgentLoopMiddleware(
  state: AgentLoopState,
  finalTurnToolPolicy: FinalTurnToolPolicy = withoutToolsOnFinalTurn,
): ChatMiddleware {
  return {
    name: "doxa-agent-loop-policy",
    onConfig: (context, config) =>
      createTerminalTurnConfig(
        state,
        context.phase,
        context.iteration,
        config,
        finalTurnToolPolicy,
      ),
    onBeforeToolCall: (_context, call) => {
      if (!state.policy) {
        return;
      }

      const observation = observeToolCall(
        state,
        call.toolName,
        call.args,
      );
      if (!observation.blocked) {
        return;
      }

      return {
        type: "skip",
        result: REPEATED_TOOL_CALL_RESULT,
      };
    },
  };
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
