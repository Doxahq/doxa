import { z } from "zod";

/**
 * The model APIs that generation can call. Add a provider here, then give it
 * a runtime in `packages/agent/src/core/providers` and an API key setting in
 * the agent worker.
 */
export const MODEL_PROVIDERS = ["openrouter", "anthropic"] as const;

export const modelProviderSchema = z.enum(MODEL_PROVIDERS);
export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const DEFAULT_MODEL_PROVIDER: ModelProvider = "openrouter";
