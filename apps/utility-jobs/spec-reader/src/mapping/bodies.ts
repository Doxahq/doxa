import {
  SPEC_READER_LIMITS,
  type SpecRequestBody,
  type SpecResponse,
} from "@doxahq/contracts/spec-reader";
import {
  entriesOf,
  isSpecObject,
  objectAt,
  stringAt,
  valueAt,
  type SpecObject,
} from "../document/tree";
import type { Located, ReferenceResolver } from "../references/resolver";
import { mediaExample } from "./examples";
import { schemaFields } from "./schema-fields";
import { specText } from "./text";

interface ChosenMedia {
  contentType: string;
  media: Located<SpecObject>;
  isJson: boolean;
}

const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/i;
const CONTENT_TYPE = /^[\w.+-]+\/[\w.+*-]+(?:\s*;.*)?$/;

/** The request body of an operation, from its first JSON media type, else its first media type. */
export function readRequestBody(
  operation: Located<SpecObject>,
  resolver: ReferenceResolver,
): SpecRequestBody | undefined {
  const body = valueAt(operation.value, "requestBody");
  if (body === undefined) return undefined;
  const resolution = resolver.resolve({ value: body, file: operation.file });
  if (!resolution.ok || !isSpecObject(resolution.resolved.value)) return undefined;

  const chosen = chooseMedia({ value: resolution.resolved.value, file: resolution.resolved.file });
  if (!chosen) return undefined;
  const { schema, schemaObject } = mediaSchema(chosen.media, "schema", resolver);
  const result: SpecRequestBody = {
    contentType: chosen.contentType,
    fields: schema ? schemaFields(schema, resolver) : [],
  };
  const example = mediaExample(chosen.media, schemaObject, resolver, chosen.isJson);
  if (example !== undefined) result.example = example;
  return result;
}

/**
 * One response for each status key, in spec order. `2XX` uses status 200
 * and `default` uses 0, each with its key as `statusLabel`. A 3.2
 * `itemSchema` describes one item of a stream, such as an SSE event.
 */
export function readResponses(
  operation: Located<SpecObject>,
  resolver: ReferenceResolver,
): SpecResponse[] {
  const responses = objectAt(operation.value, "responses");
  if (!responses) return [];

  const result: SpecResponse[] = [];
  for (const [key, value] of entriesOf(responses)) {
    const status = responseStatus(key);
    if (!status) continue;
    const resolution = resolver.resolve({ value, file: operation.file });
    if (!resolution.ok || !isSpecObject(resolution.resolved.value)) continue;
    result.push(readResponse(status, { value: resolution.resolved.value, file: resolution.resolved.file }, resolver));
  }
  return result;
}

function readResponse(
  status: { status: number; statusLabel?: string },
  response: Located<SpecObject>,
  resolver: ReferenceResolver,
): SpecResponse {
  const result: SpecResponse = { ...status, fields: [] };
  const description = specText(stringAt(response.value, "description"), SPEC_READER_LIMITS.maxDescriptionChars);
  if (description) result.description = description;

  const chosen = chooseMedia(response);
  if (!chosen) return result;
  result.contentType = chosen.contentType;

  const whole = mediaSchema(chosen.media, "schema", resolver);
  const item = whole.schema ? undefined : mediaSchema(chosen.media, "itemSchema", resolver);
  const schema = whole.schema ?? item?.schema;
  if (schema) result.fields = schemaFields(schema, resolver);
  if (item?.schema) result.stream = true;
  const example = mediaExample(chosen.media, whole.schemaObject ?? item?.schemaObject, resolver, chosen.isJson);
  if (example !== undefined) result.example = example;
  return result;
}

/** `200`, `2XX` or `default`; any other key is not a status. */
function responseStatus(key: string): { status: number; statusLabel?: string } | undefined {
  if (/^[1-5]\d\d$/.test(key)) return { status: Number(key) };
  if (/^[1-5]XX$/i.test(key)) return { status: Number(key[0]) * 100, statusLabel: key.toUpperCase() };
  if (key === "default") return { status: 0, statusLabel: "default" };
  return undefined;
}

/** The first JSON media type of a `content` map, else its first valid media type. */
function chooseMedia(owner: Located<SpecObject>): ChosenMedia | undefined {
  const content = objectAt(owner.value, "content");
  if (!content) return undefined;
  const candidates = entriesOf(content).flatMap(([contentType, media]) =>
    CONTENT_TYPE.test(contentType) && isSpecObject(media)
      ? [{ contentType, media: { value: media, file: owner.file }, isJson: JSON_MEDIA_TYPE.test(contentType) }]
      : []
  );
  return candidates.find((candidate) => candidate.isJson) ?? candidates[0];
}

function mediaSchema(
  media: Located<SpecObject>,
  key: "schema" | "itemSchema",
  resolver: ReferenceResolver,
): { schema?: Located; schemaObject?: SpecObject } {
  const value = valueAt(media.value, key);
  if (value === undefined) return {};
  const schema = { value, file: media.file };
  const resolution = resolver.resolve(schema);
  return {
    schema,
    schemaObject: resolution.ok && isSpecObject(resolution.resolved.value) ? resolution.resolved.value : undefined,
  };
}
