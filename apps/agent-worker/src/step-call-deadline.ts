/**
 * A call inside a workflow step that took too long or failed with a bare
 * runtime error. The local runtime can hide an error behind
 * "internal error; reference = …", so this error names the call.
 */
export class StepCallError extends Error {
  readonly call: string;
  readonly timedOut: boolean;

  constructor(call: string, message: string, options: { timedOut: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "StepCallError";
    this.call = call;
    this.timedOut = options.timedOut;
  }
}

/** Shorter than the silence that came before the hidden runtime errors. */
export const DEFAULT_STEP_CALL_TIMEOUT_MS = 45_000;

export interface StepCallInput {
  /** Names the call in the error and the log, for example "analysis checkpoint read". */
  call: string;
  jobId: string;
  timeoutMs?: number;
}

/**
 * Runs one call of a workflow step with a time limit. A typed error, such as
 * a non-retryable one, passes through unchanged. A bare `Error` or a timeout
 * becomes a `StepCallError`, which the step retries like any other error.
 */
export async function withStepCallDeadline<T>(
  input: StepCallInput,
  run: () => Promise<T>,
): Promise<T> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_STEP_CALL_TIMEOUT_MS;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new StepCallError(
        input.call,
        `${capitalize(input.call)} did not finish within ${Math.ceil(timeoutMs / 1000)} seconds.`,
        { timedOut: true },
      ));
    }, timeoutMs);
  });
  const operation = run();
  // After a timeout nothing awaits the call, so its late failure must not
  // become an uncaught rejection.
  operation.catch(() => undefined);

  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    const failure = toStepCallFailure(input.call, error);
    logStepCallFailure(input, failure, Date.now() - startedAt);
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

function toStepCallFailure(call: string, error: unknown): unknown {
  if (error instanceof StepCallError) return error;
  if (!isBareError(error)) return error;
  return new StepCallError(call, `${capitalize(call)} failed: ${error.message}`, {
    timedOut: false,
    cause: error,
  });
}

function isBareError(error: unknown): error is Error {
  return error instanceof Error && error.constructor === Error;
}

function logStepCallFailure(input: StepCallInput, failure: unknown, durationMs: number): void {
  console.error(JSON.stringify({
    service: "doxa-agent-worker",
    eventType: "generation_step_call_failed",
    jobId: input.jobId,
    call: input.call,
    durationMs,
    timedOut: failure instanceof StepCallError && failure.timedOut,
    error: failure instanceof Error ? failure.message : String(failure),
  }));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
