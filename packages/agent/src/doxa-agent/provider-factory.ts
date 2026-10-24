import { modelProvider, openrouter } from "../core";
import type { Provider } from "../core";
import type { AgentConfig } from "../types";
import { DEFAULT_MODEL } from "./constants";

export function createProviderFromConfig(config: AgentConfig): Provider {
  if (config.provider) return config.provider;
  const model = config.model || DEFAULT_MODEL;
  // Without a provider name, keep the OpenRouter default and its environment key fallback.
  if (!config.modelProvider) return openrouter({ apiKey: config.apiKey, model });
  if (!config.apiKey) {
    throw new Error(`An API key is required for the ${config.modelProvider} model provider.`);
  }
  return modelProvider({
    provider: config.modelProvider,
    apiKey: config.apiKey,
    model,
    promptCache: config.promptCache,
    onModelCallRetry: config.onModelCallRetry,
  });
}
