import { requestAgentContainerDestroy } from "@doxahq/generation";
import type { Env } from "../env";

interface CancellationJobs {
  markCancelled(
    jobId: string,
    message: string,
    eventType?: string,
    data?: Record<string, unknown>,
  ): Promise<boolean>;
  addEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface GenerationCancellationInput {
  jobId: string;
  message: string;
  eventType?: string;
  data?: Record<string, unknown>;
}

export interface GenerationCancellationResult {
  transitioned: boolean;
  containerDestroyRequested: boolean;
}

export async function cancelGenerationJob(
  env: Env,
  jobs: CancellationJobs,
  input: GenerationCancellationInput,
): Promise<GenerationCancellationResult> {
  const transitioned = await jobs.markCancelled(
    input.jobId,
    input.message,
    input.eventType,
    input.data,
  );
  if (!transitioned) {
    return { transitioned: false, containerDestroyRequested: false };
  }

  // The job is already cancelled in the database. A failure to reach the
  // container must not turn a committed cancellation into a server error.
  const containerDestroyRequested = await recordContainerDestroyAttempt(
    env,
    jobs,
    input.jobId,
  ).catch((error: unknown) => {
    console.error("Container destroy attempt failed.", {
      jobId: input.jobId,
      message: error instanceof Error ? error.message : "Unknown error.",
    });
    return false;
  });
  return { transitioned: true, containerDestroyRequested };
}

export async function recordContainerDestroyAttempt(
  env: Env,
  jobs: Pick<CancellationJobs, "addEvent">,
  jobId: string,
): Promise<boolean> {
  const destroyed = await requestAgentContainerDestroy(jobId, {
    agentContainerBinding: env.AGENT_CONTAINER,
    agentContainerUrl: env.AGENT_CONTAINER_URL,
  });
  await jobs.addEvent(
    jobId,
    destroyed ? "container_destroy_requested" : "container_destroy_unavailable",
    destroyed
      ? "Agent container destroy requested."
      : "Agent container destroy could not be requested from this runtime.",
    { ok: destroyed },
  );
  return destroyed;
}
