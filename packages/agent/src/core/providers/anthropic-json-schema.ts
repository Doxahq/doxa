import type { JsonSchema } from "../structured-output";

/**
 * Anthropic structured outputs accept a subset of JSON Schema
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs):
 * every object needs `additionalProperties: false`, `minItems` may only be
 * 0 or 1, and length, range and `maxItems` constraints return a 400. The
 * caller's own validator still checks the dropped constraints.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
]);

const MAX_SUPPORTED_MIN_ITEMS = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convertValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convertValue);
  return isRecord(value) ? toAnthropicJsonSchema(value) : value;
}

export function toAnthropicJsonSchema(schema: JsonSchema): JsonSchema {
  const converted: JsonSchema = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(keyword)) continue;
    if (keyword === "oneOf") {
      converted.anyOf = convertValue(value);
      continue;
    }
    if (keyword === "minItems" && typeof value === "number") {
      converted.minItems = Math.min(value, MAX_SUPPORTED_MIN_ITEMS);
      continue;
    }
    if (keyword === "properties" && isRecord(value)) {
      converted.properties = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [name, convertValue(property)]),
      );
      continue;
    }
    converted[keyword] = convertValue(value);
  }
  if (converted.type === "object") converted.additionalProperties = false;
  return converted;
}
