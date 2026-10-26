import { describe, expect, test } from "vitest";

import { createProvider, modelProvider } from "../src/core";
import { createTerminalTurnConfig, createAgentLoopState } from "../src/core/agent-loop-policy";
import { getTanStackProviderRuntime } from "../src/core/provider";
import { modelProviderRuntime } from "../src/core/providers";
import { createProviderFromConfig } from "../src/doxa-agent/provider-factory";

const call = { responseFormat: "json" as const, temperature: 0.2, maxTokens: 8000 };

describe("model provider runtimes", () => {
  test("OpenRouter keeps its OpenAI-compatible option names", () => {
    expect(modelProviderRuntime("openrouter").modelOptions(call)).toEqual({
      streamOptions: { includeUsage: true },
      responseFormat: { type: "json_object" },
      temperature: 0.2,
      maxCompletionTokens: 8000,
    });
  });

  test("Anthropic uses its own option names and sends no JSON mode", () => {
    expect(modelProviderRuntime("anthropic").modelOptions(call)).toEqual({
      temperature: 0.2,
      max_tokens: 8000,
    });
    expect(modelProviderRuntime("anthropic").modelOptions({})).toEqual({});
  });

  test("defaults to Anthropic", () => {
    expect(modelProviderRuntime()).toBe(modelProviderRuntime("anthropic"));
  });
});

describe("final writing turn per provider", () => {
  const state = () => createAgentLoopState({ finalizationPrompt: "Write the page now." }, 2);
  const config = {
    messages: [{ role: "user" as const, content: "Write the page." }],
    tools: ["Read"],
    modelOptions: { temperature: 0.2 },
  };

  test("OpenRouter removes the tools", () => {
    const turn = createTerminalTurnConfig(
      state(), "beforeModel", 1, config, modelProviderRuntime("openrouter").finalTurnToolPolicy,
    );
    expect(turn?.tools).toEqual([]);
    expect(turn?.modelOptions).toEqual({ temperature: 0.2, toolChoice: "none" });
  });

  test("Anthropic keeps the tools and sets tool_choice none", () => {
    const turn = createTerminalTurnConfig(
      state(), "beforeModel", 1, config, modelProviderRuntime("anthropic").finalTurnToolPolicy,
    );
    expect(turn?.tools).toEqual(["Read"]);
    expect(turn?.modelOptions).toEqual({ temperature: 0.2, tool_choice: "none" });
    expect(turn?.messages.at(-1)).toEqual({ role: "user", content: "Write the page now." });
  });

  test("Anthropic sends no tool_choice when the call has no tools", () => {
    const turn = createTerminalTurnConfig(
      state(), "beforeModel", 1, { ...config, tools: [] }, modelProviderRuntime("anthropic").finalTurnToolPolicy,
    );
    expect(turn?.modelOptions).toEqual({ temperature: 0.2 });
  });
});

describe("provider creation", () => {
  test("the config name selects the runtime", () => {
    const provider = createProvider({
      name: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      model: "claude-haiku-5-5",
    });
    expect(getTanStackProviderRuntime(provider)?.modelOptions({ maxTokens: 10 })).toEqual({ max_tokens: 10 });
  });

  test("modelProvider fills the provider's default API URL", () => {
    const provider = modelProvider({ provider: "anthropic", apiKey: "sk-ant-test", model: "claude-haiku-5-5" });
    expect(provider.config).toEqual({
      name: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      model: "claude-haiku-5-5",
    });
  });

  test("an Anthropic bearer token works in place of the key", () => {
    const provider = createProviderFromConfig({
      cwd: "/tmp",
      toolPolicy: "read_only",
      modelProvider: "anthropic",
      authToken: "sk-ant-oat01-short",
      model: "claude-sonnet-5-5",
    });

    expect(provider.config).toMatchObject({ name: "anthropic", authToken: "sk-ant-oat01-short", apiKey: "" });
    expect(() => createProviderFromConfig({
      cwd: "/tmp",
      toolPolicy: "read_only",
      modelProvider: "openrouter",
      authToken: "sk-ant-oat01-short",
    })).toThrow("A bearer token works only with the anthropic model provider, not openrouter.");
  });

  test("the agent config picks the provider and requires its key", () => {
    const provider = createProviderFromConfig({
      cwd: "/tmp",
      toolPolicy: "read_only",
      modelProvider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5-5",
    });
    expect(provider.config.name).toBe("anthropic");
    expect(() => createProviderFromConfig({ cwd: "/tmp", toolPolicy: "read_only", modelProvider: "anthropic" })).toThrow(
      "An API key is required for the anthropic model provider.",
    );
  });
});
