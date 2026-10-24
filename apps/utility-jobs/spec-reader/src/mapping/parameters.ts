import { SPEC_READER_LIMITS, type SpecParameter, type SpecSkipCode } from "@doxahq/contracts/spec-reader";
import {
  arrayAt,
  entriesOf,
  isSpecObject,
  objectAt,
  stringAt,
  valueAt,
  type SpecObject,
} from "../document/tree";
import type { Located, ReferenceResolver } from "../references/resolver";
import { parameterExample } from "./examples";
import {
  headerNameProblem,
  isParameterLocation,
  pathTemplateNames,
  type ParameterLocation,
} from "./operation-checks";
import { printScalar } from "./print-value";
import { schemaFields } from "./schema-fields";
import { labelOf } from "./schema-types";
import { specName, specText } from "./text";

export type ParametersResult =
  | { ok: true; parameters: SpecParameter[] }
  | { ok: false; code: SpecSkipCode; message: string };

interface DeclaredParameter {
  parameter: Located<SpecObject>;
  location: ParameterLocation;
  name: string;
}

/**
 * The parameters of one operation. Operation parameters replace path item
 * parameters with the same name and location. A 3.2 `querystring`
 * parameter becomes one query parameter for each field of its schema. A
 * path template name with no declaration gets a required string parameter.
 */
export function readParameters(
  path: string,
  lists: readonly (Located | undefined)[],
  resolver: ReferenceResolver,
): ParametersResult {
  const declared = new Map<string, DeclaredParameter>();
  for (const list of lists) {
    if (!list) continue;
    if (!Array.isArray(list.value)) return problem("invalid_parameters", "Parameters must be a list.");
    for (const entry of list.value) {
      const resolution = resolver.resolve({ value: entry, file: list.file });
      if (!resolution.ok) return problem(resolution.failure.code, resolution.failure.message);
      const { value, file } = resolution.resolved;
      if (!isSpecObject(value)) return problem("invalid_parameter", "A parameter is not an object.");

      const location = valueAt(value, "in");
      const name = specName(valueAt(value, "name"));
      if (!isParameterLocation(location)) return problem("invalid_parameter", "A parameter has an unknown location.");
      if (!name) return problem("invalid_parameter", "A parameter has no valid name.");
      const headerProblem = location === "header" ? headerNameProblem(name) : undefined;
      if (headerProblem) return problem("invalid_parameter", headerProblem);
      declared.set(`${location}:${name}`, { parameter: { value, file }, location, name });
    }
  }

  const parameters = [...declared.values()].flatMap((entry) => readParameter(entry, resolver));
  for (const name of pathTemplateNames(path)) {
    if (!parameters.some((parameter) => parameter.in === "path" && parameter.name === name)) {
      parameters.push({ name, in: "path", type: "string", required: true });
    }
  }
  return { ok: true, parameters };
}

function readParameter(
  { parameter, location, name }: DeclaredParameter,
  resolver: ReferenceResolver,
): SpecParameter[] {
  const schema = parameterSchema(parameter);
  if (location === "querystring") {
    return schema
      ? schemaFields(schema, resolver).map((field) => ({ ...field, in: "query" as const }))
      : [];
  }

  const resolution = schema ? resolver.resolve(schema) : undefined;
  const schemaObject = resolution?.ok && isSpecObject(resolution.resolved.value)
    ? resolution.resolved.value
    : undefined;
  const result: SpecParameter = {
    name,
    in: location,
    type: schema ? labelOf(schema, resolver) : "string",
    // A path parameter is always required.
    required: location === "path" || valueAt(parameter.value, "required") === true,
  };
  const description = specText(
    stringAt(parameter.value, "description"),
    SPEC_READER_LIMITS.maxFieldDescriptionChars,
  );
  if (description) result.description = description;
  const example = parameterExample(parameter, schemaObject, resolver);
  if (example !== undefined) result.example = example;
  const enumValues = schemaObject ? enumValuesOf(schemaObject) : undefined;
  if (enumValues) result.enumValues = enumValues;
  return [result];
}

/** The schema of a parameter: `schema`, or the schema of its first `content` media type. */
function parameterSchema(parameter: Located<SpecObject>): Located | undefined {
  const schema = valueAt(parameter.value, "schema");
  if (schema !== undefined) return { value: schema, file: parameter.file };
  const content = objectAt(parameter.value, "content");
  const media = content ? entriesOf(content)[0]?.[1] : undefined;
  const mediaSchema = isSpecObject(media) ? valueAt(media, "schema") : undefined;
  return mediaSchema === undefined ? undefined : { value: mediaSchema, file: parameter.file };
}

/** The allowed values of a schema, or of the items of an array schema. */
function enumValuesOf(schema: SpecObject): string[] | undefined {
  const items = objectAt(schema, "items");
  const values = arrayAt(schema, "enum") ?? (items ? arrayAt(items, "enum") : undefined);
  if (!values?.length) return undefined;
  return values
    .slice(0, SPEC_READER_LIMITS.maxEnumValues)
    .map((entry) => printScalar(entry, SPEC_READER_LIMITS.maxNameChars))
    .filter((entry): entry is string => entry !== undefined);
}

function problem(code: SpecSkipCode, message: string): ParametersResult {
  return { ok: false, code, message };
}
