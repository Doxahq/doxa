import {
  DEFAULT_MODEL_PROVIDER,
  modelProviderSchema,
  type InternalApiRpc,
  type ModelProvider,
} from "@doxahq/contracts";
import { GenerationNonRetryableError as NonRetryableError } from "./generation-errors";

export interface ModelProviderEnv {
  DOXA_MODEL_PROVIDER?: string;
  /** Writes the last retry of a failing page. Defaults to the planner model. */
  DOXA_WRITER_FALLBACK_MODEL?: string;
  DOXA_REST_EXTRACTION_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export interface ModelCredentials {
  modelProvider: ModelProvider;
  modelApiKey: string;
}

/** What one stage authenticates with: a short-lived Anthropic token, or the provider's API key. */
export type StageModelAuth =
  | ModelCredentials
  | { modelProvider: "anthropic"; modelAuthToken: string };

interface ModelProviderSettings {
  label: string;
  apiKeyName: keyof ModelProviderEnv;
  placeholders: readonly string[];
  /** Model IDs differ between providers: `anthropic/claude-haiku-5.5` on OpenRouter is `claude-haiku-5-5` on Anthropic. */
  modelIdPattern: RegExp;
  modelIdExample: string;
}

const MODEL_PROVIDER_SETTINGS = {
  openrouter: {
    label: "OpenRouter",
    apiKeyName: "OPENROUTER_API_KEY",
    placeholders: ["your_key", "replace-with-openrouter-api-key"],
    modelIdPattern: /^[^/\s]+\/[^/\s]+$/,
    modelIdExample: "anthropic/claude-haiku-5.5",
  },
  anthropic: {
    label: "Anthropic",
    apiKeyName: "ANTHROPIC_API_KEY",
    placeholders: ["replace-with-anthropic-api-key"],
    modelIdPattern: /^claude-[^/\s]+$/,
    modelIdExample: "claude-haiku-5-5",
  },
} satisfies Record<ModelProvider, ModelProviderSettings>;

export function resolveModelProvider(env: ModelProviderEnv): ModelProvider {
  const configured = env.DOXA_MODEL_PROVIDER?.trim();
  if (!configured) return DEFAULT_MODEL_PROVIDER;
  const parsed = modelProviderSchema.safeParse(configured);
  if (!parsed.success) {
    throw new NonRetryableError(
      `DOXA_MODEL_PROVIDER "${configured}" is not supported. Use one of: ${modelProviderSchema.options.join(", ")}.`,
    );
  }
  return parsed.data;
}

/** Returns the selected provider and its API key, or fails when the key is missing or a placeholder. */
export function resolveModelCredentials(env: ModelProviderEnv): ModelCredentials {
  const modelProvider = resolveModelProvider(env);
  const settings = MODEL_PROVIDER_SETTINGS[modelProvider];
  const modelApiKey = env[settings.apiKeyName]?.trim();
  if (!modelApiKey || settings.placeholders.includes(modelApiKey)) {
    throw new NonRetryableError(
      `${settings.apiKeyName} must be configured with a real ${settings.label} API key.`,
    );
  }
  return { modelProvider, modelApiKey };
}

/** Fails before any model call when a model ID belongs to another provider. */
export function assertModelsMatchProvider(
  modelProvider: ModelProvider,
  models: readonly string[],
): void {
  const settings = MODEL_PROVIDER_SETTINGS[modelProvider];
  const mismatched = models.filter((model) => !settings.modelIdPattern.test(model));
  if (mismatched.length > 0) {
    throw new NonRetryableError(
      `Model ${mismatched.map((model) => `"${model}"`).join(", ")} is not a model ID for ${settings.label} ` +
        `(for example "${settings.modelIdExample}"). Update DOXA_PLANNER_MODEL and DOXA_WRITER_MODEL for DOXA_MODEL_PROVIDER=${modelProvider}.`,
    );
  }
}

/** Resolves the credentials and checks that the planner and writer models belong to the provider. */
export function resolveModelCredentialsFor(
  env: ModelProviderEnv,
  models: readonly string[],
): ModelCredentials {
  const credentials = resolveModelCredentials(env);
  assertModelsMatchProvider(credentials.modelProvider, models);
  return credentials;
}

/**
 * The credentials of one stage. With Anthropic, the API mints a short-lived
 * token when it has federation set up (production); otherwise, as in local
 * development or with another provider, the stage uses the static API key.
 */
export async function resolveStageModelAuth(
  env: ModelProviderEnv,
  api: Pick<InternalApiRpc, "createModelAccessToken">,
  models: readonly string[],
): Promise<StageModelAuth> {
  const modelProvider = resolveModelProvider(env);
  assertModelsMatchProvider(modelProvider, models);
  if (modelProvider === "anthropic") {
    const accessToken = await api.createModelAccessToken();
    if (accessToken) return { modelProvider, modelAuthToken: accessToken.token };
  }
  return resolveModelCredentials(env);
}

/** Every configured provider key, so that error messages never show one. */
export function modelApiKeySecrets(env: ModelProviderEnv): string[] {
  return Object.values(MODEL_PROVIDER_SETTINGS)
    .map((settings) => env[settings.apiKeyName]?.trim() ?? "")
    .filter((key) => key.length > 0);
}

export interface GenerationModels {
  plannerModel: string;
  writerModel: string;
  writerFallbackModel?: string;
  restExtractionModel?: string;
}

/**
 * The models of a run. The fallback writer defaults to the planner model, a
 * stronger model of the same provider; none is set when it equals the writer.
 */
export function resolveGenerationModels(
  env: Pick<ModelProviderEnv, "DOXA_WRITER_FALLBACK_MODEL" | "DOXA_REST_EXTRACTION_MODEL">,
  config: { plannerModel: string; writerModel: string },
): GenerationModels {
  // Only the model fields: the container's model config is a strict schema,
  // and callers pass the whole execution config.
  const { plannerModel, writerModel } = config;
  const fallback = env.DOXA_WRITER_FALLBACK_MODEL?.trim() || plannerModel;
  // The model route extracts endpoints with the writer model unless the setting names another.
  const restExtraction = env.DOXA_REST_EXTRACTION_MODEL?.trim() || writerModel;
  return {
    plannerModel,
    writerModel,
    ...(fallback === writerModel ? {} : { writerFallbackModel: fallback }),
    ...(restExtraction === writerModel ? {} : { restExtractionModel: restExtraction }),
  };
}

/** Every model a run calls, for the provider check. */
export function generationModelIds(models: GenerationModels): string[] {
  const optional = [models.writerFallbackModel, models.restExtractionModel].filter(
    (model): model is string => model !== undefined,
  );
  return [models.plannerModel, models.writerModel, ...optional];
}
