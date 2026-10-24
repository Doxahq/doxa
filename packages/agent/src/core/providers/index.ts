import { DEFAULT_MODEL_PROVIDER, type ModelProvider } from "@doxahq/contracts";
import { anthropicRuntime } from "./anthropic";
import { openRouterRuntime } from "./openrouter";
import type { ModelProviderRuntime } from "./types";

export type { ModelCallOptions, ModelProviderRuntime } from "./types";

const MODEL_PROVIDER_RUNTIMES = {
  openrouter: openRouterRuntime,
  anthropic: anthropicRuntime,
} satisfies Record<ModelProvider, ModelProviderRuntime>;

export function modelProviderRuntime(
  provider: ModelProvider = DEFAULT_MODEL_PROVIDER,
): ModelProviderRuntime {
  return MODEL_PROVIDER_RUNTIMES[provider];
}
