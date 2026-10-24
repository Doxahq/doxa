import { jobFailure, type JobOutcome } from "./outcome";

/** One job call: the raw input bytes in, one outcome out. */
export type JobHandler<T> = (input: Uint8Array) => JobOutcome<T> | Promise<JobOutcome<T>>;

export interface JobStreams {
  stdin: AsyncIterable<Uint8Array | string>;
  stdout: { write(text: string): unknown };
}

/**
 * The entry of a job bundle. It reads the whole input from stdin, runs the
 * handler once and writes its outcome to stdout. A thrown error becomes
 * `job_failed` with the error name only, because an error message can quote
 * the input.
 */
export async function runJobMain<T>(
  handler: JobHandler<T>,
  streams: JobStreams = { stdin: process.stdin, stdout: process.stdout },
): Promise<void> {
  let outcome: JobOutcome<T>;
  try {
    outcome = await handler(await readAll(streams.stdin));
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    outcome = jobFailure("job_failed", `The job failed with ${name}.`);
  }
  streams.stdout.write(JSON.stringify(outcome));
}

async function readAll(stream: AsyncIterable<Uint8Array | string>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
