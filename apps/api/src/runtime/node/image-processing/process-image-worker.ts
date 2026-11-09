import { fork } from "node:child_process";
import type { z } from "zod";
import type {
  CompressedImage,
  ImageCompressionInput,
  ImageCompressor,
} from "../../../services/site-assets/image-compression";
import type {
  CleanedSvgBytes,
  SvgCleaner,
  SvgCleaningInput,
} from "../../../services/site-assets/image-content";
import {
  childReplySchema,
  cleanSvgResultSchema,
  compressResultSchema,
  type ChildJob,
} from "./child-protocol";

export interface ProcessImageWorkerOptions {
  /** The built `child.ts`. */
  readonly childPath: string;
  /** Two 2 MB, 22 MP jobs peaked at about 740 MB on 2 vCPU. */
  readonly maxRunning?: number;
  /** A burst waits here. */
  readonly maxWaiting?: number;
  /** After this wait the caller no longer wants the result. */
  readonly maxWaitMs?: number;
  readonly jobTimeoutMs?: number;
}

const DEFAULT_MAX_RUNNING = 2;
const DEFAULT_MAX_WAITING = 16;
const DEFAULT_MAX_WAIT_MS = 8_000;
const DEFAULT_JOB_TIMEOUT_MS = 10_000;
/**
 * The parsed tree of an SVG lives in this heap. A 2 MB file of 500,000 empty
 * elements needs 1.5 GB, and two such jobs must not exhaust the API's task.
 * A real image with thousands of elements stays far below this.
 */
const CHILD_HEAP_LIMIT_MB = 512;

type JobOutcome<T> =
  | { readonly status: "done"; readonly value: T }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "no_slot" };

/**
 * Parses untrusted images away from the API thread. Each job runs in a new
 * child process, so a parser crash or a hang costs one job and not the API.
 * The child's memory returns to the system when it exits, and one upload
 * never shares a process with the next one.
 */
export class ProcessImageWorker implements ImageCompressor, SvgCleaner {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly maxRunning: number;
  private readonly maxWaiting: number;
  private readonly maxWaitMs: number;
  private readonly jobTimeoutMs: number;

  constructor(private readonly options: ProcessImageWorkerOptions) {
    this.maxRunning = options.maxRunning ?? DEFAULT_MAX_RUNNING;
    this.maxWaiting = options.maxWaiting ?? DEFAULT_MAX_WAITING;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  }

  /** Null means: store the original. A compression problem never fails an upload. */
  async compress(input: ImageCompressionInput): Promise<CompressedImage | null> {
    const outcome = await this.run({ kind: "compress", input }, compressResultSchema);
    if (outcome.status === "done") return outcome.value;
    if (outcome.status === "failed") {
      console.warn(`Image compression failed. The original file is stored. ${outcome.reason}`);
    }
    return null;
  }

  /** Null means an invalid SVG. Rejects when no result exists: nothing uncleaned can be stored. */
  async clean(input: SvgCleaningInput): Promise<CleanedSvgBytes | null> {
    const outcome = await this.run({ kind: "clean_svg", input }, cleanSvgResultSchema);
    if (outcome.status === "done") return outcome.value;
    throw new Error(outcome.status === "failed" ? outcome.reason : "No free image worker.");
  }

  private async run<S extends z.ZodType>(job: ChildJob, result: S): Promise<JobOutcome<z.infer<S>>> {
    if (!(await this.takeSlot())) return { status: "no_slot" };
    try {
      return await this.runInChild(job, result);
    } finally {
      this.releaseSlot();
    }
  }

  private async takeSlot(): Promise<boolean> {
    if (this.running < this.maxRunning) {
      this.running += 1;
      return true;
    }
    if (this.waiting.length >= this.maxWaiting) return false;
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(grant), 1);
        resolve(false);
      }, this.maxWaitMs);
      this.waiting.push(grant);
    });
  }

  /** A waiting job inherits the slot, so `running` does not change. */
  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }

  private runInChild<S extends z.ZodType>(job: ChildJob, result: S): Promise<JobOutcome<z.infer<S>>> {
    return new Promise((resolve) => {
      const child = fork(this.options.childPath, [], {
        env: { NODE_ENV: "production" },
        execArgv: [`--max-old-space-size=${CHILD_HEAP_LIMIT_MB}`],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const fail = (reason: string) => finish({ status: "failed", reason });
      const timer = setTimeout(() => fail("The job timed out."), this.jobTimeoutMs);

      let finished = false;
      function finish(outcome: JobOutcome<z.infer<S>>): void {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve(outcome);
      }

      child.once("error", (cause) => fail(cause.message));
      // Not "exit": that event can arrive before the last message is read.
      child.once("disconnect", () => fail("The child ended without a reply."));
      child.once("message", (message) => {
        const reply = childReplySchema.safeParse(message);
        if (!reply.success) return fail("The child sent an invalid reply.");
        if (!reply.data.ok) return fail(reply.data.reason);
        const value = result.safeParse(reply.data.result);
        if (value.success) finish({ status: "done", value: value.data });
        else fail("The child sent an invalid result.");
      });
      child.send(job, (cause) => {
        if (cause) fail(cause.message);
      });
    });
  }
}
