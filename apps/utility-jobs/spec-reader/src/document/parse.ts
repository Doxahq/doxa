import { SPEC_READER_LIMITS } from "@doxahq/contracts/spec-reader";
import {
  parseAllDocuments,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
} from "yaml";
import { documentIssue, jsonIssue, yamlIssue, type DocumentIssue } from "./parse-issues";
import { DocumentTooDeepError, toSpecTree, UnsupportedValueError } from "./safe-tree";
import type { SpecValue } from "./tree";

export type DocumentParseResult =
  | { ok: true; value: SpecValue }
  | { ok: false; issue: DocumentIssue };

type ParsedText = { ok: true; value: unknown } | { ok: false; issue: DocumentIssue };

/**
 * YAML 1.2 with the core schema: `no` stays a string and `010` stays decimal.
 * Merge keys and custom tags are off, so no tag builds an object or code.
 */
const YAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  version: "1.2",
  schema: "core",
  merge: false,
  uniqueKeys: true,
  intAsBigInt: true,
  customTags: [],
  strict: true,
  prettyErrors: false,
};

/**
 * Parses one spec file. A `.json` file goes through `JSON.parse`, which
 * keeps the source text of integers that a number cannot hold. Any other
 * file is YAML: one document only, no duplicate keys, no unknown tags and at
 * most 50 aliases. The result is a spec tree with no prototypes. A failure
 * names the problem from a fixed table and, when the parser knows it, the
 * line and the column.
 */
export function parseSpecDocument(path: string, text: string): DocumentParseResult {
  const parsed = path.toLowerCase().endsWith(".json") ? parseJson(text) : parseYaml(text);
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, value: toSpecTree(parsed.value, SPEC_READER_LIMITS.maxDocumentDepth) };
  } catch (error) {
    if (error instanceof DocumentTooDeepError) return failure(documentIssue("too_deep", "too_deep"));
    if (error instanceof UnsupportedValueError) return failure(documentIssue("parse_failed", "unsupported_value"));
    throw error;
  }
}

function parseJson(text: string): ParsedText {
  try {
    return { ok: true, value: JSON.parse(text, keepLargeIntegers) };
  } catch (error) {
    return failure(jsonIssue(error, text));
  }
}

/** A JSON.parse reviver: an integer that a number rounds keeps its exact digits as a bigint. */
function keepLargeIntegers(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
  const source = context?.source;
  return source !== undefined && /^-?\d+$/.test(source) ? BigInt(source) : value;
}

function parseYaml(text: string): ParsedText {
  const documents = parseAllDocuments(text, YAML_OPTIONS);
  if (!Array.isArray(documents) || documents.length === 0) {
    return failure(documentIssue("parse_failed", "yaml_empty"));
  }
  const [document, second] = documents;
  if (second) return failure(yamlIssue({ code: "MULTIPLE_DOCS", pos: [second.range[0], second.range[1]] }, text));

  const [error] = document.errors;
  if (error) return failure(yamlIssue(error, text));
  const unknownTag = document.warnings.find((warning) => warning.code === "TAG_RESOLVE_FAILED");
  if (unknownTag) return failure(yamlIssue(unknownTag, text));
  try {
    return { ok: true, value: document.toJS({ maxAliasCount: SPEC_READER_LIMITS.maxYamlAliases }) };
  } catch (error) {
    // `toJS` throws a ReferenceError when the aliases expand past the limit.
    if (error instanceof ReferenceError) return failure(documentIssue("parse_failed", "yaml_alias_limit"));
    throw error;
  }
}

function failure(issue: DocumentIssue): { ok: false; issue: DocumentIssue } {
  return { ok: false, issue };
}
