import type { AgentOptions as AgentLoopOptions, Message, RunResult, TokenUsage } from "./types";
import { executeTool, toToolDefinitions } from "./tool";
import { truncateUntrustedAwareOutput } from "./untrusted-content";

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 48_000;
const DEFAULT_MAX_SINGLE_TOOL_OUTPUT_CHARS = 8_000;

export async function runAgentLoop(options: AgentLoopOptions, userMessage: string): Promise<RunResult> {
  const messages: Message[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: userMessage },
  ];
  const tools = options.tools ?? [];
  const toolDefinitions = tools.length > 0 ? toToolDefinitions(tools) : undefined;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  let retainedToolOutputChars = 0;
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;

  for (let steps = 1; steps <= maxSteps; steps++) {
    const response = await options.provider.chat({
      model: options.model,
      messages,
      tools: options.responseFormat === "json" ? undefined : toolDefinitions,
      responseFormat: options.responseFormat,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });

    usage = mergeUsage(usage, response.usage);
    finishReason = response.finishReason;
    messages.push(response.message);

    if (!response.message.toolCalls?.length) {
      return {
        text: response.message.content ?? "",
        messages,
        steps,
        usage,
        finishReason,
      };
    }

    for (const toolCall of response.message.toolCalls) {
      const output = await executeTool(tools, toolCall.function.name, toolCall.function.arguments);
      const remaining = Math.max(0, (options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS) - retainedToolOutputChars);
      const retained = truncateToolOutput(output, Math.min(options.maxSingleToolOutputChars ?? DEFAULT_MAX_SINGLE_TOOL_OUTPUT_CHARS, remaining));
      retainedToolOutputChars += retained.length;
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: retained,
      });
    }
  }

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return {
    text: lastAssistant?.role === "assistant" ? lastAssistant.content ?? "" : "",
    messages,
    steps: maxSteps,
    usage,
    finishReason,
  };
}

function truncateToolOutput(output: string, allowedChars: number): string {
  if (allowedChars <= 0) {
    return "Tool output omitted because the per-run tool context budget is exhausted.";
  }
  if (output.length <= allowedChars) return output;
  // A cut inside an untrusted-data block closes the block before the notice.
  return truncateUntrustedAwareOutput(output, allowedChars, "... (tool output truncated)");
}

function mergeUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    cost: sumOptional(current.cost, next.cost),
    promptCost: sumOptional(current.promptCost, next.promptCost),
    completionCost: sumOptional(current.completionCost, next.completionCost),
  };
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}
