import {
  arrayAt,
  isSpecObject,
  objectAt,
  stringAt,
  valueAt,
  type SpecObject,
  type SpecValue,
} from "../document/tree";
import type { Located, ReferenceResolver, Resolved } from "../references/resolver";

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set(["string", "integer", "number", "boolean"]);

/** Nested arrays and choices that a label still spells out. */
const MAX_LABEL_DEPTH = 3;
/** Choices of `oneOf` or `anyOf` that a label lists. */
const MAX_LABEL_CHOICES = 8;

/**
 * The type of a schema as the docs show it: `string (date-time)`,
 * `integer (int64)`, `array of string`, `one of: Card, BankAccount`, or
 * the name of a referenced object schema. The `pattern` keyword is never
 * compiled into a regular expression.
 */
export function schemaTypeLabel(
  schema: Resolved,
  resolver: ReferenceResolver,
  depth = 0,
): string {
  const value = schema.value;
  if (!isSpecObject(value)) return "any";

  const types = declaredTypes(value);
  const primitive = types.length === 1 && PRIMITIVE_TYPES.has(types[0]!);
  if (primitive) return withFormat(types[0]!, value);
  if (types.length > 1) return unionLabel(types, value);

  if (types[0] === "array" || valueAt(value, "items") !== undefined) {
    if (depth >= MAX_LABEL_DEPTH) return "array";
    const items = valueAt(value, "items");
    return items === undefined
      ? "array"
      : `array of ${labelOf({ value: items, file: schema.file }, resolver, depth + 1)}`;
  }

  const choices = arrayAt(value, "oneOf") ?? arrayAt(value, "anyOf");
  if (choices) {
    if (depth >= MAX_LABEL_DEPTH) return "one of several types";
    const labels = choices
      .slice(0, MAX_LABEL_CHOICES)
      .map((choice) => labelOf({ value: choice, file: schema.file }, resolver, depth + 1));
    return `one of: ${labels.join(", ")}${choices.length > MAX_LABEL_CHOICES ? ", …" : ""}`;
  }

  const allOf = arrayAt(value, "allOf");
  if (allOf?.length === 1 && !objectAt(value, "properties")) {
    return labelOf({ value: allOf[0]!, file: schema.file }, resolver, depth + 1);
  }
  if (schema.name) return schema.name;
  if (valueAt(value, "enum") !== undefined) return "enum";
  if (valueAt(value, "const") !== undefined) return "constant";
  if (types[0] === "object" || objectAt(value, "properties") || allOf) return "object";
  return types[0] ?? "any";
}

/** The label of a schema that may still be a reference. */
export function labelOf(located: Located, resolver: ReferenceResolver, depth = 0): string {
  const resolution = resolver.resolve(located);
  if (!resolution.ok) return "unknown";
  const { resolved } = resolution;
  // A named primitive, such as `OrderId: { type: string }`, shows its primitive type.
  if (resolved.name && !isPrimitive(resolved.value)) return resolved.name;
  return schemaTypeLabel(resolved, resolver, depth);
}

function isPrimitive(value: SpecValue): boolean {
  if (!isSpecObject(value)) return false;
  const types = declaredTypes(value);
  return types.length === 1 && PRIMITIVE_TYPES.has(types[0]!);
}

/** `type` as a list. OpenAPI 3.1 allows a list such as `[string, "null"]`. */
function declaredTypes(schema: SpecObject): string[] {
  const type = valueAt(schema, "type");
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function withFormat(type: string, schema: SpecObject): string {
  const format = stringAt(schema, "format")?.trim();
  return format && /^[A-Za-z0-9_.+-]{1,40}$/.test(format) ? `${type} (${format})` : type;
}

function unionLabel(types: readonly string[], schema: SpecObject): string {
  const nonNull = types.filter((type) => type !== "null");
  const label = nonNull.length === 1 && PRIMITIVE_TYPES.has(nonNull[0]!)
    ? withFormat(nonNull[0]!, schema)
    : nonNull.join(" or ");
  return nonNull.length < types.length ? `${label || "null"}, nullable` : label;
}
