import {
  SPEC_FILE_ISSUE_MESSAGES,
  SPEC_READER_LIMITS,
  SPEC_SKIP_MESSAGES,
  type SpecFileIssueReason,
  type SpecReaderOutput,
  type SpecSkipCode,
} from "@doxahq/contracts/spec-reader";
import { z } from "zod";

/**
 * Gate G3: the schema of the spec-reader output. The job ran on hostile
 * input in another container, so its output is untrusted data. Every string
 * and list has a cap, every object is strict, and parsing builds new
 * objects, so no prototype or extra key survives.
 */

const MAX_LIST = SPEC_READER_LIMITS.maxOperations;
const name = z.string().min(1).max(SPEC_READER_LIMITS.maxNameChars);
const title = z.string().min(1).max(SPEC_READER_LIMITS.maxTitleChars);
const description = z.string().min(1).max(SPEC_READER_LIMITS.maxDescriptionChars);
const fieldDescription = z.string().min(1).max(SPEC_READER_LIMITS.maxFieldDescriptionChars);
const example = z.string().max(SPEC_READER_LIMITS.maxExampleChars);
const path = z.string().min(1).max(SPEC_READER_LIMITS.maxPathChars);
const filePath = z.string().min(1).max(SPEC_READER_LIMITS.maxPathChars);
const method = z.string().regex(/^[A-Z][A-Z0-9-]{0,19}$/);

/** A key of a fixed message table: the job sends codes, and only our own text reaches users. */
function tableKey<Key extends string>(table: Readonly<Record<Key, string>>) {
  return z.custom<Key>((value) => typeof value === "string" && Object.hasOwn(table, value));
}
const skipCode = tableKey<SpecSkipCode>(SPEC_SKIP_MESSAGES);
const fileIssueReason = tableKey<SpecFileIssueReason>(SPEC_FILE_ISSUE_MESSAGES);
const lineNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const fieldSchema = z.strictObject({
  name: z.string().min(1).max(SPEC_READER_LIMITS.maxPathChars),
  type: z.string().min(1).max(SPEC_READER_LIMITS.maxPathChars),
  required: z.boolean(),
  description: fieldDescription.optional(),
  example: example.optional(),
});

const parameterSchema = z.strictObject({
  // A 3.2 querystring parameter turns into fields, whose names are dotted paths.
  name: z.string().min(1).max(SPEC_READER_LIMITS.maxPathChars),
  in: z.enum(["path", "query", "header", "cookie"]),
  type: z.string().min(1).max(SPEC_READER_LIMITS.maxPathChars),
  required: z.boolean(),
  description: fieldDescription.optional(),
  example: example.optional(),
  enumValues: z.array(z.string().max(SPEC_READER_LIMITS.maxNameChars)).max(SPEC_READER_LIMITS.maxEnumValues).optional(),
});

const fields = z.array(fieldSchema).max(SPEC_READER_LIMITS.maxSchemaFields);

const responseSchema = z.strictObject({
  status: z.number().int().min(0).max(599),
  statusLabel: z.enum(["1XX", "2XX", "3XX", "4XX", "5XX", "default"]).optional(),
  contentType: z.string().min(1).max(SPEC_READER_LIMITS.maxNameChars).optional(),
  description: description.optional(),
  example: example.optional(),
  fields,
  stream: z.boolean().optional(),
});

const securitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("schemes"), schemeNames: z.array(name).min(1).max(20) }),
]);

const operationSchema = z.strictObject({
  method,
  path,
  tag: name.optional(),
  summary: title.optional(),
  description: description.optional(),
  deprecated: z.boolean(),
  parameters: z.array(parameterSchema).max(SPEC_READER_LIMITS.maxSchemaFields),
  requestBody: z.strictObject({
    contentType: z.string().min(1).max(SPEC_READER_LIMITS.maxNameChars),
    fields,
    example: example.optional(),
  }).optional(),
  responses: z.array(responseSchema).max(100),
  security: securitySchema.optional(),
});

const parsedSpecSchema = z.strictObject({
  outcome: z.literal("parsed"),
  root: filePath,
  specVersion: z.string().min(1).max(20),
  files: z.array(filePath).min(1).max(SPEC_READER_LIMITS.maxFiles),
  info: z.strictObject({ title: title.optional(), description: description.optional() }),
  servers: z.array(z.strictObject({ url: path, description: title.optional() })).max(20),
  securitySchemes: z.array(z.strictObject({
    name,
    kind: z.enum(["bearer", "basic", "apiKey", "oauth2", "openIdConnect"]),
    location: z.enum(["header", "query", "cookie"]).optional(),
    parameterName: name.optional(),
    description: fieldDescription.optional(),
  })).max(100),
  tags: z.array(z.strictObject({
    name,
    displayName: title.optional(),
    description: description.optional(),
  })).max(SPEC_READER_LIMITS.maxTags),
  operations: z.array(operationSchema).min(1).max(MAX_LIST),
  skippedOperations: z.array(z.strictObject({
    method: z.string().max(20),
    path: z.string().max(SPEC_READER_LIMITS.maxNameChars),
    code: skipCode,
    message: z.string().max(500),
  })).max(1_000),
});

const rejectedSpecSchema = z.strictObject({
  outcome: z.literal("rejected"),
  root: filePath,
  code: z.enum([
    "parse_failed",
    "too_deep",
    "unsupported_version",
    "no_paths",
    "upgrade_failed",
    "too_many_operations",
    "too_many_tags",
    "no_valid_operations",
  ]),
  message: z.string().max(500),
});

export const specReaderOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("need_files"),
    needFiles: z.array(filePath).min(1).max(SPEC_READER_LIMITS.maxFiles),
  }),
  z.strictObject({
    status: z.literal("read"),
    readerVersion: z.string().regex(/^[0-9a-f]{64}$/),
    specs: z.array(z.discriminatedUnion("outcome", [parsedSpecSchema, rejectedSpecSchema])).max(SPEC_READER_LIMITS.maxFiles),
    fileIssues: z.array(z.strictObject({
      file: filePath,
      code: z.enum(["parse_failed", "too_deep"]),
      reason: fileIssueReason,
      line: lineNumber.optional(),
      column: lineNumber.optional(),
    })).max(SPEC_READER_LIMITS.maxFiles),
  }),
]) satisfies z.ZodType<SpecReaderOutput>;

export type SpecReaderOutputCheck =
  | { ok: true; output: SpecReaderOutput }
  | { ok: false };

/** Gate G3. A result that fails anywhere is rejected as a whole. */
export function checkSpecReaderOutput(value: unknown): SpecReaderOutputCheck {
  const result = specReaderOutputSchema.safeParse(value);
  return result.success ? { ok: true, output: result.data } : { ok: false };
}
