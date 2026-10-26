import { describe, expect, test, vi } from "vitest";

import { GenerationNonRetryableError } from "../src/generation-errors";
import {
  modelApiKeySecrets,
  resolveModelCredentials,
  resolveModelCredentialsFor,
  resolveStageModelAuth,
} from "../src/model-provider";

const OPENROUTER_KEY = "sk-or-v1-real";
const ANTHROPIC_KEY = "sk-ant-real";

describe("resolveModelCredentials", () => {
  test("defaults to Anthropic", () => {
    expect(resolveModelCredentials({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENROUTER_API_KEY: OPENROUTER_KEY })).toEqual({
      modelProvider: "anthropic",
      modelApiKey: ANTHROPIC_KEY,
    });
  });

  test("uses the OpenRouter key when OpenRouter is selected", () => {
    expect(resolveModelCredentials({ DOXA_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: OPENROUTER_KEY })).toEqual({
      modelProvider: "openrouter",
      modelApiKey: OPENROUTER_KEY,
    });
  });

  test("uses the Anthropic key when Anthropic is selected", () => {
    expect(resolveModelCredentials({
      DOXA_MODEL_PROVIDER: " anthropic ",
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    })).toEqual({ modelProvider: "anthropic", modelApiKey: ANTHROPIC_KEY });
  });

  test("stops without a retry when the selected key is missing or a placeholder", () => {
    expect(() => resolveModelCredentials({
      DOXA_MODEL_PROVIDER: "anthropic",
      OPENROUTER_API_KEY: OPENROUTER_KEY,
    })).toThrow(new GenerationNonRetryableError(
      "ANTHROPIC_API_KEY must be configured with a real Anthropic API key.",
    ));
    expect(() => resolveModelCredentials({ DOXA_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "your_key" })).toThrow(
      "OPENROUTER_API_KEY must be configured with a real OpenRouter API key.",
    );
  });

  test("rejects an unknown provider", () => {
    expect(() => resolveModelCredentials({ DOXA_MODEL_PROVIDER: "gemini" })).toThrow(
      'DOXA_MODEL_PROVIDER "gemini" is not supported. Use one of: openrouter, anthropic.',
    );
  });
});

describe("resolveModelCredentialsFor", () => {
  const anthropicEnv = { DOXA_MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: ANTHROPIC_KEY };

  test("accepts model IDs of the selected provider", () => {
    expect(resolveModelCredentialsFor(anthropicEnv, ["claude-sonnet-5-5", "claude-haiku-5-5"]).modelProvider)
      .toBe("anthropic");
    expect(resolveModelCredentialsFor(
      { DOXA_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: OPENROUTER_KEY },
      ["x-ai/grok-4.5:nitro", "anthropic/claude-haiku-5.5"],
    ).modelProvider).toBe("openrouter");
  });

  test("names the model IDs that belong to another provider", () => {
    expect(() => resolveModelCredentialsFor(anthropicEnv, ["claude-sonnet-5-5", "anthropic/claude-haiku-5.5"]))
      .toThrow(
        'Model "anthropic/claude-haiku-5.5" is not a model ID for Anthropic (for example "claude-haiku-5-5").',
      );
    expect(() => resolveModelCredentialsFor({ DOXA_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: OPENROUTER_KEY }, ["claude-haiku-5-5"]))
      .toThrow(GenerationNonRetryableError);
  });
});

test("modelApiKeySecrets lists every configured key", () => {
  expect(modelApiKeySecrets({ OPENROUTER_API_KEY: OPENROUTER_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY }))
    .toEqual([OPENROUTER_KEY, ANTHROPIC_KEY]);
  expect(modelApiKeySecrets({})).toEqual([]);
});

describe("resolveStageModelAuth", () => {
  const MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"];
  const tokenApi = (token: string | null) => ({
    createModelAccessToken: vi.fn(async () => token ? { token, expiresAt: "2026-10-26T13:00:00.000Z" } : null),
  });

  test("production: Anthropic stages use the short-lived token, not the key", async () => {
    const api = tokenApi("sk-ant-oat01-short");

    await expect(resolveStageModelAuth({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }, api, MODELS)).resolves.toEqual({
      modelProvider: "anthropic",
      modelAuthToken: "sk-ant-oat01-short",
    });
  });

  test("production needs no static key once federation works", async () => {
    await expect(resolveStageModelAuth({}, tokenApi("sk-ant-oat01-short"), MODELS)).resolves.toMatchObject({
      modelAuthToken: "sk-ant-oat01-short",
    });
  });

  test("local development: without federation the stage keeps the static key", async () => {
    await expect(resolveStageModelAuth({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }, tokenApi(null), MODELS)).resolves.toEqual({
      modelProvider: "anthropic",
      modelApiKey: ANTHROPIC_KEY,
    });
  });

  test("OpenRouter never asks for an Anthropic token", async () => {
    const api = tokenApi("sk-ant-oat01-short");

    const auth = await resolveStageModelAuth(
      { DOXA_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: OPENROUTER_KEY },
      api,
      ["anthropic/claude-sonnet-5.5"],
    );

    expect(auth).toEqual({ modelProvider: "openrouter", modelApiKey: OPENROUTER_KEY });
    expect(api.createModelAccessToken).not.toHaveBeenCalled();
  });

  test("no token and no key fails before the stage runs", async () => {
    await expect(resolveStageModelAuth({}, tokenApi(null), MODELS)).rejects.toBeInstanceOf(GenerationNonRetryableError);
  });
});
