import type { GenerateJobMessage, GenerationJobDto } from "@doxahq/contracts";
import type { Env } from "../env";
import { JobsRepository } from "../repositories/jobs";
import { runContainerGeneration } from "./container-generation";
import { publishStarterDocs } from "./starter-docs";

/**
 * `job` is set when the dispatcher ran the generation synchronously and the
 * job row changed; `null` means the admitted job is still current.
 */
export type DispatchResult =
  | { status: "dispatched"; job: GenerationJobDto | null }
  | { status: "failed"; message: string };

export interface GenerationDispatcher {
  dispatch(message: GenerateJobMessage): Promise<DispatchResult>;
}

/** Keeps the Worker alive until `promise` settles, e.g. `waitUntil`. */
export type Defer = (promise: Promise<unknown>) => void;

interface GenerationJobInput {
  jobId: string;
  projectId: string;
}

type RunGeneration = (input: GenerationJobInput) => Promise<unknown>;

interface GenerationJobReader {
  getForUser(userId: string, jobId: string): Promise<GenerationJobDto | null>;
}

export interface GenerationQueue {
  send(message: GenerateJobMessage): Promise<unknown>;
}

export class QueueGenerationDispatcher implements GenerationDispatcher {
  constructor(private readonly queue: GenerationQueue) {}

  async dispatch(message: GenerateJobMessage): Promise<DispatchResult> {
    await this.queue.send(message);
    return { status: "dispatched", job: null };
  }
}

export class ContainerInlineGenerationDispatcher
  implements GenerationDispatcher
{
  constructor(
    private readonly deps: { run: RunGeneration; defer: Defer },
  ) {}

  async dispatch(message: GenerateJobMessage): Promise<DispatchResult> {
    this.deps.defer(this.runLoggingFailures(toJobInput(message)));
    return { status: "dispatched", job: null };
  }

  private async runLoggingFailures(input: GenerationJobInput): Promise<void> {
    try {
      await this.deps.run(input);
    } catch (err) {
      console.error(
        err instanceof Error ? err.message : "Container generation failed.",
      );
    }
  }
}

export class StarterDevGenerationDispatcher implements GenerationDispatcher {
  constructor(
    private readonly deps: {
      publish: RunGeneration;
      jobs: GenerationJobReader;
    },
  ) {}

  async dispatch(message: GenerateJobMessage): Promise<DispatchResult> {
    try {
      await this.deps.publish(toJobInput(message));
      const job = await this.deps.jobs.getForUser(
        message.userId,
        message.jobId,
      );
      return { status: "dispatched", job };
    } catch (err) {
      return {
        status: "failed",
        message:
          err instanceof Error ? err.message : "Starter dev generation failed.",
      };
    }
  }
}

export class UnsupportedModeGenerationDispatcher
  implements GenerationDispatcher
{
  constructor(private readonly mode: string) {}

  async dispatch(): Promise<DispatchResult> {
    return {
      status: "failed",
      message: `Unsupported generation mode: ${this.mode}.`,
    };
  }
}

export function createGenerationDispatcher(
  env: Env,
  defer: Defer,
  jobs: GenerationJobReader = new JobsRepository(env),
): GenerationDispatcher {
  const mode = env.GENERATION_MODE;
  switch (mode) {
    case undefined:
    case "queue":
      return new QueueGenerationDispatcher(env.GENERATION_QUEUE);
    case "container-inline":
      return new ContainerInlineGenerationDispatcher({
        run: (input) => runContainerGeneration(env, input),
        defer,
      });
    case "starter-dev":
      return new StarterDevGenerationDispatcher({
        publish: (input) => publishStarterDocs(env, input),
        jobs,
      });
    default:
      return unsupportedOrQueue(env, mode);
  }
}

// GENERATION_MODE comes from Worker vars, so values outside the typed union
// reach runtime. An empty string falls back to the queue, as before.
function unsupportedOrQueue(env: Env, mode: string): GenerationDispatcher {
  if (mode === "") return new QueueGenerationDispatcher(env.GENERATION_QUEUE);
  return new UnsupportedModeGenerationDispatcher(mode);
}

function toJobInput(message: GenerateJobMessage): GenerationJobInput {
  return { jobId: message.jobId, projectId: message.projectId };
}
