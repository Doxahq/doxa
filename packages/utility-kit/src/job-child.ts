import { spawn } from "node:child_process";
import { jobFailure, parseJobOutcome, type JobOutcome } from "./outcome";

/** Where a job bundle lives and how much memory its child gets. */
export interface JobChildSpec {
  /** Absolute path of the job bundle. */
  entry: string;
  /** The only folder the child may read. It holds the job bundle. */
  readDirectory: string;
  /** The V8 heap of the child, in MB. */
  heapMb: number;
}

export interface JobChildRun extends JobChildSpec {
  /** The job input. The child reads it from stdin. */
  input: Uint8Array;
  /** The child is killed after this time. */
  timeoutMs: number;
  maxOutputBytes: number;
  /** The Node binary. Default: the binary of this process. */
  nodePath?: string;
  signal?: AbortSignal;
}

/**
 * The arguments of a job child. Node 26 then denies the network, child
 * processes, worker threads, add-ons, WASI and every file write; the child
 * reads only its own folder. It cannot build code from strings, `__proto__`
 * does not exist, and no signal can open its inspector.
 */
export function jobChildArguments(spec: JobChildSpec): string[] {
  return [
    "--permission",
    `--allow-fs-read=${spec.readDirectory}`,
    "--disallow-code-generation-from-strings",
    "--disable-proto=delete",
    "--disable-sigusr1",
    `--max-old-space-size=${spec.heapMb}`,
    spec.entry,
  ];
}

/**
 * Runs one job call in a new child process with no environment. The child
 * gets the input on stdin and writes one outcome to stdout. A child that
 * runs too long or writes too much is killed with SIGKILL.
 */
export function runJobChild(run: JobChildRun): Promise<JobOutcome<unknown>> {
  return new Promise((resolve) => {
    const child = spawn(run.nodePath ?? process.execPath, jobChildArguments(run), {
      cwd: run.readDirectory,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stopped: JobOutcome<never> | undefined;

    const stop = (outcome: JobOutcome<never>) => {
      stopped ??= outcome;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(jobFailure("timeout", `The job did not finish within ${run.timeoutMs} ms.`)),
      run.timeoutMs,
    );
    const onAbort = () => stop(jobFailure("job_failed", "The job call was cancelled."));
    run.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > run.maxOutputBytes) {
        stop(jobFailure("output_too_large", `The job output is larger than ${run.maxOutputBytes} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    // Stderr can quote the job input, so it is read and dropped, never logged.
    child.stderr.resume();
    // A child that exits before it reads all input closes stdin early.
    child.stdin.on("error", () => undefined);
    const finish = (outcome: JobOutcome<unknown>) => {
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      resolve(stopped ?? outcome);
    };
    child.on("error", () => finish(jobFailure("crashed", "The job process could not start.")));
    child.on("close", (exitCode, signal) => {
      const outcome = parseJobOutcome(Buffer.concat(stdout).toString("utf8"));
      const crashed = !outcome.ok &&
        outcome.error.code === "invalid_output" &&
        (exitCode !== 0 || signal !== null);
      finish(
        crashed
          ? jobFailure("crashed", `The job process ended with ${signal ?? `exit code ${exitCode}`}.`)
          : outcome,
      );
    });

    if (run.signal?.aborted) onAbort();
    child.stdin.end(run.input);
  });
}
