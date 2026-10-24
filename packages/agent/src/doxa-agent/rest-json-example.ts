import type { RestApiReferenceField } from "../types";

export type JsonExampleValue =
  | string
  | number
  | boolean
  | null
  | JsonExampleValue[]
  | { [key: string]: JsonExampleValue };

type JsonExampleObject = { [key: string]: JsonExampleValue };

/** One step of a field path: a key, and how many `[]` follow it. */
interface PathStep {
  key: string;
  arrayDepth: number;
}

/** The key of a body whose root is an array, as in the field `[].id`. */
const ROOT_KEY = "";

/**
 * The example body of a list of fields, in the shape of the real body. A
 * field name is a dotted path and `[]` marks the items of an array, so the
 * fields `data[].id` and `data[].key` give `{"data": [{"id": …, "key": …}]}`.
 * A field that has child fields becomes their container.
 */
export function exampleFromFields(fields: readonly RestApiReferenceField[]): JsonExampleValue {
  const root: JsonExampleObject = {};
  for (const field of fields) insert(root, pathSteps(field.name), fieldExampleValue(field));
  const rootArray = root[ROOT_KEY];
  return Object.keys(root).length === 1 && rootArray !== undefined ? rootArray : root;
}

/**
 * The example value of one field: its spec example, typed by the field
 * type, or a `<type>` placeholder.
 */
export function fieldExampleValue(field: RestApiReferenceField): JsonExampleValue {
  const example = field.example;
  if (example === undefined) return `<${field.type}>`;
  if (example === "null") return null;
  const type = field.type.toLowerCase();
  if (type.includes("boolean") && (example === "true" || example === "false")) return example === "true";
  if (/\b(?:integer|number|float|double)\b/.test(type) && /^-?(?:\d+|\d*\.\d+)$/.test(example)) {
    const value = Number(example);
    if (Number.isSafeInteger(value) || !Number.isInteger(value)) return value;
  }
  return example;
}

function pathSteps(name: string): PathStep[] {
  return name.split(".").map((part) => {
    const match = /^(.*?)((?:\[\])*)$/.exec(part);
    return { key: match?.[1] ?? part, arrayDepth: (match?.[2]?.length ?? 0) / 2 };
  });
}

function insert(container: JsonExampleObject, steps: readonly PathStep[], value: JsonExampleValue): void {
  const [step, ...rest] = steps;
  if (!step) return;
  if (rest.length === 0) {
    // Child fields that came first already made this key their container.
    if (!isObjectContainer(container[step.key], step.arrayDepth)) {
      container[step.key] = wrapInArrays(value, step.arrayDepth);
    }
    return;
  }
  insert(childObject(container, step), rest, value);
}

/** The object that the next step writes into, made when missing or when a leaf held its place. */
function childObject(container: JsonExampleObject, step: PathStep): JsonExampleObject {
  if (!isObjectContainer(container[step.key], step.arrayDepth)) {
    container[step.key] = wrapInArrays({}, step.arrayDepth);
  }
  let current: JsonExampleValue | undefined = container[step.key];
  for (let depth = 0; depth < step.arrayDepth && Array.isArray(current); depth += 1) {
    current = current[0];
  }
  return current !== undefined && isObject(current) ? current : {};
}

function isObjectContainer(value: JsonExampleValue | undefined, arrayDepth: number): boolean {
  let current = value;
  for (let depth = 0; depth < arrayDepth; depth += 1) {
    if (!Array.isArray(current) || current.length === 0) return false;
    current = current[0];
  }
  return current !== undefined && isObject(current);
}

function isObject(value: JsonExampleValue): value is JsonExampleObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapInArrays(value: JsonExampleValue, depth: number): JsonExampleValue {
  let wrapped = value;
  for (let index = 0; index < depth; index += 1) wrapped = [wrapped];
  return wrapped;
}
