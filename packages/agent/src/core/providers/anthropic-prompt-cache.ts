import type { ChatMiddleware, ModelMessage, TextPart } from "@tanstack/ai";
import type { PromptCachePolicy } from "../prompt-cache";
import type { PromptCacheSupport } from "./types";

interface AnthropicCacheControl {
  type: "ephemeral";
  ttl: PromptCachePolicy["ttl"];
}

type CacheMarkedPart = TextPart<{ cache_control: AnthropicCacheControl }>;

function cacheControl(policy: PromptCachePolicy): AnthropicCacheControl {
  return { type: "ephemeral", ttl: policy.ttl };
}

/**
 * The text parts that this module made from a plain string, so the marker
 * can be taken off again before the next call moves it. Anthropic allows at
 * most 4 markers in one request.
 */
const markedParts = new WeakSet<CacheMarkedPart>();

function isMarkable(message: ModelMessage): message is ModelMessage<string> {
  return (message.role === "user" || message.role === "tool") &&
    typeof message.content === "string" &&
    message.content.length > 0;
}

function withoutMarker(message: ModelMessage): ModelMessage {
  if (!Array.isArray(message.content) || message.content.length !== 1) return message;
  const [part] = message.content;
  if (!part || !markedParts.has(part as CacheMarkedPart)) return message;
  return { ...message, content: (part as CacheMarkedPart).content };
}

function withMarker(
  message: ModelMessage<string>,
  policy: PromptCachePolicy,
): ModelMessage {
  const part: CacheMarkedPart = {
    type: "text",
    content: message.content,
    metadata: { cache_control: cacheControl(policy) },
  };
  markedParts.add(part);
  return { ...message, content: [part] };
}

/** Puts the moving marker on the newest user or tool message, and only there. */
export function markNewestMessage(
  messages: readonly ModelMessage[],
  policy: PromptCachePolicy,
): ModelMessage[] {
  const unmarked = messages.map(withoutMarker);
  for (let index = unmarked.length - 1; index >= 0; index--) {
    const message = unmarked[index]!;
    if (message.role === "assistant") continue;
    if (isMarkable(message)) unmarked[index] = withMarker(message, policy);
    break;
  }
  return unmarked;
}

/**
 * Only an agent loop reads its own messages again. A one-shot call would pay
 * the cache write price for a prefix that no later call reads.
 */
function movingMarkerMiddleware(policy: PromptCachePolicy): ChatMiddleware {
  return {
    name: "doxa-anthropic-prompt-cache",
    onConfig: (context, config) =>
      context.phase === "beforeModel" && context.hasTools
        ? { messages: markNewestMessage(config.messages, policy) }
        : undefined,
  };
}

/**
 * Anthropic caches a prefix in the order tools, system, messages. The marker
 * at the end of the system prompt covers the tools and the shared run
 * context, which every page of a run sends unchanged.
 */
export const anthropicPromptCache: PromptCacheSupport = {
  systemPrompts: (systemPrompt, policy) => [
    { content: systemPrompt, metadata: { cache_control: cacheControl(policy) } },
  ],
  middleware: movingMarkerMiddleware,
};
