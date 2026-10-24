import {
  MAX_REPORTED_SKIPPED_OPERATIONS,
  type ReferenceFileIssue,
  type ReferenceSkippedOperation,
  type ReferenceSpecReport,
} from "@doxahq/contracts";
import {
  SPEC_FILE_ISSUE_MESSAGES,
  SPEC_READER_LIMITS,
  SPEC_REJECTION_MESSAGES,
  SPEC_SKIP_MESSAGES,
  type ParsedSpec,
  type SpecFileIssue,
  type SpecReadOutcome,
} from "@doxahq/contracts/spec-reader";
import type { SpecFileRefusal } from "./file-gate";

/** Why the agent container did not send a file: gate G1, or a limit of the request. */
export type SpecRequestRefusal = SpecFileRefusal | "too_many_files" | "request_too_large";

/** Why the agent container did not send a file, or why the job did not read it. */
export type SpecNotReadCode =
  | SpecRequestRefusal
  | "no_reader"
  | "reader_failed"
  | "invalid_output"
  | "too_many_rounds";

const NOT_READ_MESSAGES = {
  invalid_path: "The path is not a relative path to a .json, .yaml or .yml file.",
  outside_checkout: "The file is outside the repository.",
  symbolic_link: "The path goes through a symbolic link. A spec file must be a regular file in the repository.",
  not_a_file: "The path is not a regular file.",
  too_large: `The file is larger than ${SPEC_READER_LIMITS.maxFileBytes / (1024 * 1024)} MB.`,
  not_utf8: "The file is not UTF-8 text.",
  nul_byte: "The file holds a NUL byte, so it is not a text file.",
  unreadable: "The file could not be read.",
  too_many_files: `The spec uses more than ${SPEC_READER_LIMITS.maxFiles} files.`,
  request_too_large: `The spec files are larger than ${SPEC_READER_LIMITS.maxRequestBytes / (1024 * 1024)} MB in total.`,
  no_reader: "The spec reader is not available for this run.",
  reader_failed: "The spec reader did not answer.",
  invalid_output: "The spec reader returned a result that failed the checks.",
  too_many_rounds: `The spec needs referenced files over more than ${SPEC_READER_LIMITS.maxNeedFilesRounds} rounds.`,
} as const satisfies Record<SpecNotReadCode, string>;

/** The codes of a refused file; the others mean that the job did not read the file. */
const REFUSAL_CODES = {
  invalid_path: true,
  outside_checkout: true,
  symbolic_link: true,
  not_a_file: true,
  too_large: true,
  not_utf8: true,
  nul_byte: true,
  unreadable: true,
  too_many_files: true,
  request_too_large: true,
} as const satisfies Record<SpecRequestRefusal, true>;

/** Gate G1 refused the file, or the run stopped before the job read it. */
export function notReadReport(path: string, code: SpecNotReadCode): ReferenceSpecReport {
  return {
    path,
    outcome: Object.hasOwn(REFUSAL_CODES, code) ? "refused" : "unread",
    code,
    message: NOT_READ_MESSAGES[code],
  };
}

/**
 * The report of one spec that the job answered. A root that did not parse
 * takes the message of its parse issue, which says what is wrong.
 */
export function outcomeReport(spec: SpecReadOutcome, issues: readonly SpecFileIssue[]): ReferenceSpecReport {
  if (spec.outcome === "parsed") return { path: spec.root, outcome: "parsed", specVersion: spec.specVersion };
  const issue = issues.find((candidate) => candidate.file === spec.root);
  return {
    path: spec.root,
    outcome: "rejected",
    code: spec.code,
    message: issue ? SPEC_FILE_ISSUE_MESSAGES[issue.reason] : SPEC_REJECTION_MESSAGES[spec.code],
  };
}

export function fileIssueReports(issues: readonly SpecFileIssue[]): ReferenceFileIssue[] {
  return issues.map((issue) => ({
    file: issue.file,
    reason: issue.reason,
    message: SPEC_FILE_ISSUE_MESSAGES[issue.reason],
    ...(issue.line === undefined ? {} : { line: issue.line }),
    ...(issue.column === undefined ? {} : { column: issue.column }),
  }));
}

/** The first skipped operations, by spec; the report keeps the full count separately. */
export function skippedOperationReports(specs: readonly ParsedSpec[]): ReferenceSkippedOperation[] {
  return specs
    .flatMap((spec) => spec.skippedOperations.map((operation) => ({
      specPath: spec.root,
      method: operation.method,
      path: operation.path,
      code: operation.code,
      message: SPEC_SKIP_MESSAGES[operation.code],
    })))
    .slice(0, MAX_REPORTED_SKIPPED_OPERATIONS);
}
