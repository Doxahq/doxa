import type { AnyTextAdapter } from "@tanstack/ai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { withoutToolsOnFinalTurn } from "../agent-loop-policy";
import type { ModelProviderRuntime } from "./types";

type OpenRouterModel = Parameters<typeof createOpenRouterText>[0];

export const openRouterRuntime: ModelProviderRuntime = {
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  createAdapter: (config, model) =>
    // The adapter types only the models it knows. OpenRouter serves newer ones too.
    createOpenRouterText(model as OpenRouterModel, config.apiKey, {
      serverURL: config.baseUrl,
      // Doxa retries in one place, `withModelCallRetry`, with its error classes.
      retryConfig: { strategy: "none" },
    }) as unknown as AnyTextAdapter,
  modelOptions: (call) => ({
    streamOptions: { includeUsage: true },
    ...(call.responseFormat === "json" && { responseFormat: { type: "json_object" } }),
    ...(call.temperature !== undefined && { temperature: call.temperature }),
    ...(call.maxTokens !== undefined && { maxCompletionTokens: call.maxTokens }),
  }),
  finalTurnToolPolicy: withoutToolsOnFinalTurn,
};
