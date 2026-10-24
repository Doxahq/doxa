/**
 * The envelope that every utility job call returns. A job writes it to
 * stdout; the supervisor and the local runner return it unchanged, or a
 * failure of their own when the job did not finish.
 */

export type JobErrorCode =
  /** The job rejected its input. */
  | "invalid_input"
  /** The job threw. */
  | "job_failed"
  | "timeout"
  | "input_too_large"
  | "output_too_large"
  /** The job process ended without an outcome: out of memory, a stack overflow, a signal. */
  | "crashed"
  /** The job wrote something that is not an outcome. */
  | "invalid_output"
  /** The supervisor already runs a job call. */
  | "busy";

export interface JobError {
  code: JobErrorCode;
  /** A fixed reason. It never quotes the job input. */
  message: string;
}

export type JobOutcome<T> =
  | { ok: true; output: T }
  | { ok: false; error: JobError };

const JOB_ERROR_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
  "invalid_input",
  "job_failed",
  "timeout",
  "input_too_large",
  "output_too_large",
  "crashed",
  "invalid_output",
  "busy",
]);

const MAX_ERROR_MESSAGE_CHARS = 500;

export function jobSuccess<T>(output: T): JobOutcome<T> {
  return { ok: true, output };
}

export function jobFailure(code: JobErrorCode, message: string): JobOutcome<never> {
  return { ok: false, error: { code, message: message.slice(0, MAX_ERROR_MESSAGE_CHARS) } };
}

/**
 * Reads an outcome from job output text. Anything that is not an outcome,
 * including a failure with an unknown code, becomes `invalid_output`.
 */
export function parseJobOutcome(text: string): JobOutcome<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return jobFailure("invalid_output", "The job output is not JSON.");
  }
  if (!isRecord(value)) {
    return jobFailure("invalid_output", "The job output is not an outcome object.");
  }
  if (value.ok === true && Object.hasOwn(value, "output")) {
    return jobSuccess(value.output);
  }
  const error = value.ok === false ? value.error : undefined;
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    isJobErrorCode(error.code) &&
    typeof error.message === "string"
  ) {
    return jobFailure(error.code, error.message);
  }
  return jobFailure("invalid_output", "The job output is not a valid outcome.");
}

function isJobErrorCode(value: string): value is JobErrorCode {
  return JOB_ERROR_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
