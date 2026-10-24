import { SPEC_READER_LIMITS } from "@doxahq/contracts/spec-reader";
import {
  arrayAt,
  entriesOf,
  isSpecObject,
  objectAt,
  valueAt,
  type SpecObject,
  type SpecValue,
} from "../document/tree";
import type { Located, ReferenceResolver } from "../references/resolver";
import { printJson, printScalar } from "./print-value";

/** The printed length of one parameter or field example. */
const MAX_SHORT_EXAMPLE_CHARS = 500;

/** The example of a schema: `example`, then the first of `examples`, then `default`. */
export function schemaExample(schema: SpecObject): string | undefined {
  const value = schemaExampleValue(schema);
  return value === undefined ? undefined : printScalar(value, MAX_SHORT_EXAMPLE_CHARS);
}

/**
 * The example of a parameter: its own `example`, then the first of its
 * `examples`, then the example of its schema.
 */
export function parameterExample(
  parameter: Located<SpecObject>,
  schema: SpecObject | undefined,
  resolver: ReferenceResolver,
): string | undefined {
  const value = valueAt(parameter.value, "example") ??
    firstExampleValue(parameter, resolver) ??
    (schema ? schemaExampleValue(schema) : undefined);
  return value === undefined ? undefined : printScalar(value, MAX_SHORT_EXAMPLE_CHARS);
}

/**
 * The example of a request or response body: the media type `example`,
 * then the first of its `examples`, then the example of its schema. A JSON
 * body prints as pretty JSON; other bodies print a string as it is. An
 * example longer than 16 KB is left out, and `externalValue` is never read.
 */
export function mediaExample(
  media: Located<SpecObject>,
  schema: SpecObject | undefined,
  resolver: ReferenceResolver,
  isJson: boolean,
): string | undefined {
  const value = valueAt(media.value, "example") ??
    firstExampleValue(media, resolver) ??
    (schema ? schemaExampleValue(schema) : undefined);
  if (value === undefined) return undefined;
  if (!isJson && typeof value === "string") {
    return value.length <= SPEC_READER_LIMITS.maxExampleChars ? value : undefined;
  }
  return printJson(value, SPEC_READER_LIMITS.maxExampleChars);
}

function schemaExampleValue(schema: SpecObject): SpecValue | undefined {
  return valueAt(schema, "example") ?? arrayAt(schema, "examples")?.[0] ?? valueAt(schema, "default");
}

/**
 * The value of the first entry of an `examples` map. An Example object can
 * be a reference; its `value` (or the 3.2 `dataValue`) is the example.
 */
function firstExampleValue(owner: Located<SpecObject>, resolver: ReferenceResolver): SpecValue | undefined {
  const examples = objectAt(owner.value, "examples");
  const first = examples ? entriesOf(examples)[0] : undefined;
  if (!first) return undefined;

  const resolution = resolver.resolve({ value: first[1], file: owner.file });
  if (!resolution.ok || !isSpecObject(resolution.resolved.value)) return undefined;
  const example = resolution.resolved.value;
  return valueAt(example, "value") ?? valueAt(example, "dataValue") ?? valueAt(example, "serializedValue");
}
