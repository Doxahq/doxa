/**
 * The contract of the `spec-reader` utility job. The agent container sends
 * spec files; the job parses them in its own container and returns neutral
 * spec facts. The facts are untrusted: the agent container checks them
 * against its own schema (gate G3) before it builds the REST reference.
 *
 * This module has no runtime dependencies, so the job bundle can import it.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

export const SPEC_READER_LIMITS = {
  /** Gate G1: the bytes of one spec file. */
  maxFileBytes: 25 * MIB,
  /** Gate G1: the bytes of one encoded request, every file included. */
  maxRequestBytes: 100 * MIB,
  /** Gate G1: the files of one request, root files included. */
  maxFiles: 200,
  /** Requests of one run that add files a `$ref` needs. */
  maxNeedFilesRounds: 4,
  /** D9 ceiling: operations of one spec. More is broken or hostile input. */
  maxOperations: 10_000,
  /** D9 ceiling: tags of one spec. Each tag becomes a model-written group page. */
  maxTags: 1_000,
  /**
   * The JSON output of one job call. Stripe's 8 MB spec gives about 40 MB,
   * because every operation repeats its expanded error schema.
   */
  maxOutputBytes: 82 * MIB,
  /** Nesting of a parsed document. */
  maxDocumentDepth: 64,
  /** A `$ref` that points at another `$ref`, and so on. */
  maxReferenceChain: 64,
  /** YAML aliases of one document. */
  maxYamlAliases: 50,
  /** Object levels that a schema expands into fields. */
  maxSchemaDepth: 6,
  /** Fields of one request body or response. */
  maxSchemaFields: 500,
  /** The printed text of one example. */
  maxExampleChars: 16 * KIB,
  maxTitleChars: 80,
  maxDescriptionChars: 4_000,
  maxFieldDescriptionChars: 1_000,
  /** Parameter, field, header, tag and scheme names. */
  maxNameChars: 200,
  maxPathChars: 2_000,
  maxEnumValues: 100,
} as const;

/** How the agent container runs the job, in its container and in local development. */
export const SPEC_READER_JOB = {
  name: "spec-reader",
  /** The port of the supervisor in the job image. */
  port: 8790,
  /** The V8 heap of the job child, in MB. */
  heapMb: 768,
  /** The job child is killed after this time. */
  childTimeoutMs: 30_000,
  /** One call from the agent container, a cold start included. */
  callTimeoutMs: 60_000,
  maxRequestBytes: SPEC_READER_LIMITS.maxRequestBytes,
  maxOutputBytes: SPEC_READER_LIMITS.maxOutputBytes,
} as const;

/** The request of one job call: the root spec files and every file they may reference. */
export interface SpecReaderInput {
  /** Root spec files, as relative POSIX paths inside the checkout. */
  roots: string[];
  /** UTF-8 text of every file the job may read, by relative POSIX path. */
  files: Record<string, string>;
  /**
   * Files that a `$ref` needed and gate G1 refused. A reference to one of
   * them fails, so the job does not ask for it again.
   */
  unavailable?: string[];
}

export type SpecReaderOutput = SpecReaderNeedFiles | SpecReaderResult;

/** A `$ref` points at files that the request did not carry. */
export interface SpecReaderNeedFiles {
  status: "need_files";
  needFiles: string[];
}

export interface SpecReaderResult {
  status: "read";
  /** The SHA-256 of the job bundle. A new parser version changes every cache key that uses it. */
  readerVersion: string;
  specs: SpecReadOutcome[];
  /**
   * Every file that the job could not parse, by path: a root, or a file
   * that a `$ref` points to. A referenced file that fails makes its
   * operations skipped, so only this list names the file and the line.
   */
  fileIssues: SpecFileIssue[];
}

export type SpecFileIssueCode = "parse_failed" | "too_deep";

/**
 * Why a file did not parse. The job returns only the reason, so gate G3 can
 * check it; the text that users see comes from this table.
 */
export const SPEC_FILE_ISSUE_MESSAGES = {
  yaml_alias_props: "An alias has an anchor or a tag. YAML does not allow them on an alias.",
  yaml_bad_alias: "An alias points to an anchor that does not exist.",
  yaml_bad_collection_type: "A value has a collection type that YAML does not allow here.",
  yaml_bad_directive: "The file has an invalid YAML directive.",
  yaml_bad_escape: "A double-quoted string has an invalid escape sequence.",
  yaml_bad_indent: "A line has the wrong indentation.",
  yaml_bad_property_order: "An anchor or a tag is in the wrong place.",
  yaml_bad_scalar_start: "A value starts with a character that YAML does not allow there. Put the value in quotes.",
  yaml_block_as_key: "A block value is used as a key. Look for a missing colon or wrong indentation.",
  yaml_block_in_flow: "A block value is inside a flow collection ([ ] or { }).",
  yaml_duplicate_key: "A key appears twice in the same mapping.",
  yaml_invalid: "The file is not valid YAML.",
  yaml_long_key: "A key is longer than 1,024 characters.",
  yaml_missing_char:
    "A closing quote or bracket is missing. A quoted string that continues on a line with too little indentation also causes this.",
  yaml_multiline_key: "A key continues on a second line. Look for a missing colon or wrong indentation.",
  yaml_multiple_anchors: "A value has more than one anchor.",
  yaml_multiple_documents: "A YAML spec file must hold exactly one document.",
  yaml_multiple_tags: "A value has more than one tag.",
  yaml_non_string_key: "A key is not a string.",
  yaml_alias_limit: `The file uses more than ${SPEC_READER_LIMITS.maxYamlAliases} YAML aliases.`,
  yaml_tab_indent: "A line is indented with a tab. YAML allows only spaces.",
  yaml_unknown_tag: "The file uses a YAML tag outside the core schema.",
  yaml_unexpected_token: "A character is in a place where YAML does not allow it.",
  yaml_empty: "The YAML file is empty.",
  json_unterminated_string: "A string has no closing quote.",
  json_property_name: "A property name is missing or not in double quotes. A trailing comma also causes this.",
  json_missing_colon: "A colon is missing after a property name.",
  json_missing_comma: "A comma or a closing bracket is missing.",
  json_unexpected_end: "The file ends before the JSON is complete.",
  json_control_character: "A string holds a control character, such as a raw tab or line break.",
  json_bad_escape: "A string has an invalid escape sequence.",
  json_bad_number: "A number is not valid JSON.",
  json_unexpected_character: "A character is in a place where JSON does not allow it.",
  json_invalid: "The file is not valid JSON.",
  too_deep: `The document nests deeper than ${SPEC_READER_LIMITS.maxDocumentDepth} levels.`,
  unsupported_value: "The document holds a value that is not JSON data.",
} as const satisfies Record<string, string>;

export type SpecFileIssueReason = keyof typeof SPEC_FILE_ISSUE_MESSAGES;

/** A file that the job could not parse, and where. */
export interface SpecFileIssue {
  file: string;
  code: SpecFileIssueCode;
  reason: SpecFileIssueReason;
  /** 1-based, when the parser knows it. */
  line?: number;
  /** 1-based, when the parser knows it. */
  column?: number;
}

export type SpecReadOutcome = ParsedSpec | RejectedSpec;

export type SpecRejectionCode =
  | "parse_failed"
  | "too_deep"
  | "unsupported_version"
  | "no_paths"
  | "upgrade_failed"
  | "too_many_operations"
  | "too_many_tags"
  | "no_valid_operations";

/** The text that users see for each rejection code. */
export const SPEC_REJECTION_MESSAGES = {
  parse_failed: "The file could not be parsed, or its root is not an object.",
  too_deep: `The document nests deeper than ${SPEC_READER_LIMITS.maxDocumentDepth} levels.`,
  unsupported_version: "The file is not Swagger 2.0 or OpenAPI 3.0, 3.1 or 3.2.",
  no_paths: "The spec has no paths.",
  upgrade_failed: "The spec could not be read as OpenAPI 3.1.",
  too_many_operations: `The spec has more than ${SPEC_READER_LIMITS.maxOperations.toLocaleString("en-US")} operations.`,
  too_many_tags: `The spec has more than ${SPEC_READER_LIMITS.maxTags.toLocaleString("en-US")} tags.`,
  no_valid_operations: "No operation of the spec passed the checks.",
} as const satisfies Record<SpecRejectionCode, string>;

export interface RejectedSpec {
  outcome: "rejected";
  root: string;
  code: SpecRejectionCode;
  message: string;
}

export interface ParsedSpec {
  outcome: "parsed";
  root: string;
  /** The version text of the file, such as `2.0` or `3.1.0`. */
  specVersion: string;
  /** Every file that the spec used, the root first, then sorted. */
  files: string[];
  info: SpecInfo;
  servers: SpecServer[];
  securitySchemes: SpecSecurityScheme[];
  /** Tags in group order: the root tag list, then first use. A 3.2 child tag follows its parent. */
  tags: SpecTag[];
  /** Operations in spec order. */
  operations: SpecOperation[];
  skippedOperations: SkippedSpecOperation[];
}

export interface SpecInfo {
  title?: string;
  description?: string;
}

export interface SpecServer {
  /** The URL with every server variable replaced by its default. */
  url: string;
  description?: string;
}

export type SpecSecuritySchemeKind = "bearer" | "basic" | "apiKey" | "oauth2" | "openIdConnect";

export interface SpecSecurityScheme {
  /** The key of the scheme in `components.securitySchemes`. */
  name: string;
  kind: SpecSecuritySchemeKind;
  /** API keys only. */
  location?: "header" | "query" | "cookie";
  /** API keys only: the header, query or cookie name. */
  parameterName?: string;
  description?: string;
}

export interface SpecTag {
  name: string;
  /** The 3.2 `summary`, else `x-displayName`. */
  displayName?: string;
  description?: string;
}

export type SpecParameterLocation = "path" | "query" | "header" | "cookie";

export interface SpecParameter {
  name: string;
  in: SpecParameterLocation;
  type: string;
  required: boolean;
  description?: string;
  example?: string;
  enumValues?: string[];
}

export interface SpecField {
  /** Dotted path; array items add `[]`, as in `items[].sku`. */
  name: string;
  type: string;
  required: boolean;
  description?: string;
  example?: string;
}

export interface SpecRequestBody {
  contentType: string;
  fields: SpecField[];
  /** Pretty-printed JSON or the raw text of a non-JSON example. */
  example?: string;
}

export interface SpecResponse {
  /** The HTTP status. A range such as `2XX` uses its first code, and `default` uses 0. */
  status: number;
  /** The status key when it is not a plain code: `2XX` or `default`. */
  statusLabel?: string;
  contentType?: string;
  description?: string;
  example?: string;
  fields: SpecField[];
  /** True for a 3.2 `itemSchema` response: the fields describe one streamed item. */
  stream?: boolean;
}

/** The security of an operation: no auth, or the schemes of its first requirement. */
export type SpecSecurity =
  | { kind: "none" }
  | { kind: "schemes"; schemeNames: string[] };

export interface SpecOperation {
  /** Upper case: a standard method, `QUERY`, or a 3.2 `additionalOperations` key. */
  method: string;
  path: string;
  /** The first tag; an operation without tags has none. */
  tag?: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  parameters: SpecParameter[];
  requestBody?: SpecRequestBody;
  responses: SpecResponse[];
  /** Absent when neither the operation nor the root declares security. */
  security?: SpecSecurity;
}

/** Why gate G2 skipped an operation. The text that users see comes from this table. */
export const SPEC_SKIP_MESSAGES = {
  invalid_method: "The HTTP method is not valid.",
  invalid_path: "The path is not valid.",
  invalid_path_item: "The path item is not an object.",
  invalid_parameters: "The parameters are not a list.",
  invalid_parameter: "A parameter has no valid name or location.",
  invalid_responses: "The responses are not an object.",
  invalid_reference: "A reference is not a relative file path or a local pointer.",
  missing_reference: "A referenced file was not sent.",
  unresolved_reference: "A reference points to nothing, or to a file that could not be read.",
  reference_cycle: "A reference chain comes back to itself.",
  reference_chain_too_long: `A reference chain is longer than ${SPEC_READER_LIMITS.maxReferenceChain} references.`,
} as const satisfies Record<string, string>;

export type SpecSkipCode = keyof typeof SPEC_SKIP_MESSAGES;

export interface SkippedSpecOperation {
  method: string;
  path: string;
  code: SpecSkipCode;
  message: string;
}
