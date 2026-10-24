import type { SpecObject, SpecValue } from "./tree";

/** Keys that can change an object's prototype when a later step copies the object. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export class DocumentTooDeepError extends Error {
  constructor(maxDepth: number) {
    super(`The document nests deeper than ${maxDepth} levels.`);
    this.name = "DocumentTooDeepError";
  }
}

export class UnsupportedValueError extends Error {
  constructor() {
    super("The document holds a value that is not JSON data.");
    this.name = "UnsupportedValueError";
  }
}

/**
 * Copies parsed data into a spec tree: every object has no prototype, the
 * prototype keys are dropped, nesting deeper than `maxDepth` fails, and a
 * bigint that fits a safe integer becomes a number.
 */
export function toSpecTree(value: unknown, maxDepth: number): SpecValue {
  return copyValue(value, 0, maxDepth);
}

function copyValue(value: unknown, depth: number, maxDepth: number): SpecValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // YAML `.inf` and `.nan` have no JSON form; they stay readable as text.
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return isSafeInteger(value) ? Number(value) : value;
    case "object":
      if (value === null) return null;
      if (depth >= maxDepth) throw new DocumentTooDeepError(maxDepth);
      return Array.isArray(value)
        ? value.map((item) => copyValue(item, depth + 1, maxDepth))
        : copyObject(value, depth, maxDepth);
    default:
      throw new UnsupportedValueError();
  }
}

function copyObject(value: object, depth: number, maxDepth: number): SpecObject {
  const copy: Record<string, SpecValue> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (PROTOTYPE_KEYS.has(key)) continue;
    copy[key] = copyValue(entry, depth + 1, maxDepth);
  }
  return copy;
}

function isSafeInteger(value: bigint): boolean {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER);
}
