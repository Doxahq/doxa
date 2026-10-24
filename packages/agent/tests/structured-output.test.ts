import { beforeEach, describe, expect, test, vi } from "vitest";

const chatMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/ai")>()),
  chat: chatMock,
}));

import { modelProvider, resetRejectedResponseSchemas, run } from "../src/core";
import type { JsonSchema, ResponseSchema } from "../src/core";
import { modelProviderRuntime } from "../src/core/providers";
import { toAnthropicJsonSchema } from "../src/core/providers/anthropic-json-schema";
import { STRUCTURE_RESPONSE_SCHEMA } from "../src/doxa-agent/response-schemas";
import { STRUCTURE_REVIEW_RESPONSE_SCHEMA } from "../src/doxa-agent/structure-review";

const reviewSchema: ResponseSchema = {
  name: "test_review",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};

function respond(chunks: unknown[]): void {
  chatMock.mockImplementationOnce(() => ({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  }));
}

function anthropicProvider() {
  return modelProvider({ provider: "anthropic", apiKey: "sk-ant-test", model: "claude-sonnet-5-5" });
}

function jsonCall(schema: ResponseSchema = reviewSchema) {
  return run(
    { provider: anthropicProvider(), systemPrompt: "Return JSON.", responseFormat: "json", responseSchema: schema },
    "Review.",
  );
}

/** Counts what Anthropic limits: optional fields, and fields with a union. */
function schemaComplexity(schema: unknown): { optional: number; unions: number } {
  if (Array.isArray(schema)) {
    return schema.reduce(
      (total, item) => {
        const next = schemaComplexity(item);
        return { optional: total.optional + next.optional, unions: total.unions + next.unions };
      },
      { optional: 0, unions: 0 },
    );
  }
  if (typeof schema !== "object" || schema === null) return { optional: 0, unions: 0 };
  const node = schema as JsonSchema;
  let optional = 0;
  let unions = Array.isArray(node.anyOf) || Array.isArray(node.type) ? 1 : 0;
  if (node.properties && typeof node.properties === "object") {
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    optional += Object.keys(node.properties).filter((name) => !required.has(name)).length;
  }
  for (const value of Object.values(node)) {
    const nested = schemaComplexity(value);
    optional += nested.optional;
    unions += nested.unions;
  }
  return { optional, unions };
}

describe("Anthropic JSON Schema dialect", () => {
  test("closes every object and drops the keywords Anthropic rejects", () => {
    expect(toAnthropicJsonSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        minLength: { type: "string", minLength: 1, maxLength: 9 },
        items: { type: "array", minItems: 3, maxItems: 5, items: { type: "object", properties: {} } },
        choice: { oneOf: [{ type: "string", const: "a" }, { type: "number", minimum: 0 }] },
      },
      required: ["minLength"],
    })).toEqual({
      type: "object",
      properties: {
        minLength: { type: "string" },
        items: { type: "array", minItems: 1, items: { type: "object", properties: {}, additionalProperties: false } },
        choice: { anyOf: [{ type: "string", const: "a" }, { type: "number" }] },
      },
      required: ["minLength"],
      additionalProperties: false,
    });
  });

  test.each([STRUCTURE_RESPONSE_SCHEMA, STRUCTURE_REVIEW_RESPONSE_SCHEMA])(
    "the $name schema stays inside Anthropic's complexity limits",
    ({ schema: source }) => {
      const schema = toAnthropicJsonSchema(source);
      const complexity = schemaComplexity(schema);

      expect(complexity.optional).toBeLessThanOrEqual(24);
      expect(complexity.unions).toBeLessThanOrEqual(16);
      expect(JSON.stringify(schema)).not.toMatch(/"(?:minLength|maxLength|maxItems|oneOf|\$schema)"/);
    },
  );
});

describe("response schema requests", () => {
  beforeEach(() => {
    chatMock.mockReset();
    resetRejectedResponseSchemas();
  });

  test("Anthropic sends the schema as output_config.format", () => {
    expect(modelProviderRuntime("anthropic").modelOptions({ responseSchema: reviewSchema })).toEqual({
      output_config: {
        format: {
          type: "json_schema",
          schema: { ...reviewSchema.schema, additionalProperties: false },
        },
      },
    });
  });

  test("OpenRouter keeps plain JSON mode", () => {
    expect(modelProviderRuntime("openrouter").modelOptions({
      responseFormat: "json",
      responseSchema: reviewSchema,
    })).toMatchObject({ responseFormat: { type: "json_object" } });
  });

  test("a refused schema runs again without it, and later calls skip it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    respond([{
      type: "RUN_ERROR",
      message: "output_config.format.schema: Schema is too complex for compilation",
      code: "400",
    }]);
    respond([{ type: "TEXT_MESSAGE_CONTENT", delta: '{"ok":true}' }, { type: "RUN_FINISHED", finishReason: "stop" }]);
    respond([{ type: "TEXT_MESSAGE_CONTENT", delta: '{"ok":true}' }, { type: "RUN_FINISHED", finishReason: "stop" }]);

    await expect(jsonCall()).resolves.toMatchObject({ text: '{"ok":true}' });
    await expect(jsonCall()).resolves.toMatchObject({ text: '{"ok":true}' });

    const sentOutputConfig = chatMock.mock.calls.map(
      ([options]) => (options as { modelOptions: Record<string, unknown> }).modelOptions.output_config,
    );
    expect(sentOutputConfig[0]).toBeDefined();
    expect(sentOutputConfig.slice(1)).toEqual([undefined, undefined]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"eventType":"response_schema_rejected"'));
    warn.mockRestore();
  });

  test("another failure is not taken for a refused schema", async () => {
    respond([{ type: "RUN_ERROR", message: "Overloaded", code: "529" }]);

    await expect(jsonCall()).rejects.toThrow("Overloaded");
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});

describe("structure parsing of schema output", () => {
  test("an empty reference field reads as missing", async () => {
    const { parseStructureResult } = await import("../src/doxa-agent/json-parsing");
    const structure = parseStructureResult(JSON.stringify({
      sections: [{
        id: "rest-api",
        title: "REST API",
        pages: [{
          id: "create-flag",
          title: "Create a flag",
          description: "Creates a flag.",
          reference: { kind: "rest", groupId: "flags", moduleId: "", endpointId: " " },
        }],
      }],
    }));

    expect(structure.sections[0]?.pages[0]?.reference).toEqual({
      kind: "rest",
      groupId: "flags",
      endpointId: undefined,
      moduleId: undefined,
      exportId: undefined,
      method: undefined,
      path: undefined,
      exportName: undefined,
      exportKind: undefined,
    });
  });
});
