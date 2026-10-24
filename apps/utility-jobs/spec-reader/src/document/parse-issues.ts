import type { SpecFileIssueCode, SpecFileIssueReason } from "@doxahq/contracts/spec-reader";
import type { ErrorCode } from "yaml";

/**
 * A parse problem of one file: a reason from the fixed list of the contract
 * and, when the parser knows it, the line and the column. Nothing of the
 * parser's own message is kept: it can quote the file.
 */
export interface DocumentIssue {
  code: SpecFileIssueCode;
  reason: SpecFileIssueReason;
  line?: number;
  column?: number;
}

/** A YAML error or warning of the `yaml` package: its code and its character offsets. */
export interface YamlProblem {
  code: ErrorCode;
  pos: readonly [number, number];
}

const YAML_REASONS = {
  ALIAS_PROPS: "yaml_alias_props",
  BAD_ALIAS: "yaml_bad_alias",
  BAD_COLLECTION_TYPE: "yaml_bad_collection_type",
  BAD_DIRECTIVE: "yaml_bad_directive",
  BAD_DQ_ESCAPE: "yaml_bad_escape",
  BAD_INDENT: "yaml_bad_indent",
  BAD_PROP_ORDER: "yaml_bad_property_order",
  BAD_SCALAR_START: "yaml_bad_scalar_start",
  BLOCK_AS_IMPLICIT_KEY: "yaml_block_as_key",
  BLOCK_IN_FLOW: "yaml_block_in_flow",
  DUPLICATE_KEY: "yaml_duplicate_key",
  IMPOSSIBLE: "yaml_invalid",
  KEY_OVER_1024_CHARS: "yaml_long_key",
  MISSING_CHAR: "yaml_missing_char",
  MULTILINE_IMPLICIT_KEY: "yaml_multiline_key",
  MULTIPLE_ANCHORS: "yaml_multiple_anchors",
  MULTIPLE_DOCS: "yaml_multiple_documents",
  MULTIPLE_TAGS: "yaml_multiple_tags",
  NON_STRING_KEY: "yaml_non_string_key",
  RESOURCE_EXHAUSTION: "yaml_alias_limit",
  TAB_AS_INDENT: "yaml_tab_indent",
  TAG_RESOLVE_FAILED: "yaml_unknown_tag",
  UNEXPECTED_TOKEN: "yaml_unexpected_token",
} as const satisfies Record<ErrorCode, SpecFileIssueReason>;

/** V8 `JSON.parse` messages, by their fixed start. */
const JSON_REASONS: ReadonlyArray<readonly [RegExp, SpecFileIssueReason]> = [
  [/^Unterminated string/, "json_unterminated_string"],
  [/^Expected (?:double-quoted property name|property name)/, "json_property_name"],
  [/^Expected ':'/, "json_missing_colon"],
  [/^Expected ',' or/, "json_missing_comma"],
  [/^Unexpected end of JSON input/, "json_unexpected_end"],
  [/^Bad control character/, "json_control_character"],
  [/^Bad (?:escaped character|Unicode escape)/, "json_bad_escape"],
  [/^(?:No number after minus sign|Exponent part is missing|Unterminated fractional number)/, "json_bad_number"],
  [/^Unexpected (?:token|non-whitespace)/, "json_unexpected_character"],
];

const JSON_POSITION = /\bat position (\d+)\b/;

export function yamlIssue(problem: YamlProblem, text: string): DocumentIssue {
  return { code: "parse_failed", reason: YAML_REASONS[problem.code], ...lineColumnAt(text, problem.pos[0]) };
}

/** Only the start of the V8 message and its position are read. */
export function jsonIssue(error: unknown, text: string): DocumentIssue {
  const parserMessage = error instanceof SyntaxError ? error.message : "";
  const reason = JSON_REASONS.find(([pattern]) => pattern.test(parserMessage))?.[1] ?? "json_invalid";
  const position = JSON_POSITION.exec(parserMessage)?.[1];
  return {
    code: "parse_failed",
    reason,
    ...(position === undefined ? {} : lineColumnAt(text, Number(position))),
  };
}

export function documentIssue(code: SpecFileIssueCode, reason: SpecFileIssueReason): DocumentIssue {
  return { code, reason };
}

/** The 1-based line and column of a character offset. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = text.indexOf("\n"); index !== -1 && index < end; index = text.indexOf("\n", index + 1)) {
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: end - lineStart + 1 };
}
