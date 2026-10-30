import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import {
  createBucketAdapter,
  createRendererAdapter,
  type Env,
} from "./runtime-bindings";
import { executePrerenderTask } from "./prerender-task";
import {
  validateTaskForRelease,
  type PrerenderTaskPayload,
} from "./task-contract";
import {
  PrerenderPermanentError,
  PrerenderTaskObsoleteError,
  PrerenderWorkflowRunner,
  type PrerenderWorkflowStep,
} from "./workflow-runtime";

export class DocsPrerenderWorkflow extends WorkflowEntrypoint<
  Env,
  PrerenderTaskPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<PrerenderTaskPayload>>,
    step: WorkflowStep,
  ): Promise<{ status: "committed" | "already_complete"; routeCount: number }> {
    let payload: PrerenderTaskPayload;
    try {
      payload = validateTaskForRelease(
        event.payload,
        this.env.DOXA_RENDERER_RELEASE_ID,
      );
    } catch (error) {
      throw new NonRetryableError(errorMessage(error));
    }

    const runner = new PrerenderWorkflowRunner({
      api: this.env.PRERENDER_TASKS,
      execute: executePrerenderTask,
      createExecutionInput: (task) => ({
        identity: task.identity,
        renderer: createRendererAdapter(
          this.env.PRERENDER_RENDERER,
          task.resolution,
          new URL(task.identity.trustedRequestOrigin).origin,
        ),
        bucket: createBucketAdapter(this.env.DOCS_RENDERED_BUCKET),
        now: () => new Date(),
      }),
    });

    try {
      return await runner.run(payload, adaptStep(step));
    } catch (error) {
      if (
        error instanceof PrerenderPermanentError ||
        error instanceof PrerenderTaskObsoleteError
      ) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  }
}

function adaptStep(step: WorkflowStep): PrerenderWorkflowStep {
  const config = {
    retries: {
      limit: 2,
      delay: "30 seconds" as const,
      backoff: "exponential" as const,
    },
    timeout: "15 minutes" as const,
  };
  return {
    validateTask: (callback) =>
      step.do("revalidate pre-render task", config, () =>
        runCallback(callback),
      ),
    renderAndCommit: (callback) =>
      step.do("render and commit documentation", config, () =>
        runCallback(callback),
      ),
    completeTask: (callback) =>
      step.do("complete pre-render task", config, () => runCallback(callback)),
  };
}

async function runCallback<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (
      error instanceof PrerenderPermanentError ||
      error instanceof PrerenderTaskObsoleteError
    ) {
      throw new NonRetryableError(error.message);
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid pre-render task.";
}
