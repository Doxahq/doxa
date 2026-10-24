import type {
  PrerenderTaskApiRpc,
  PrerenderTaskEligibilityResult,
  PrerenderTaskFenceResult,
} from "@doxahq/contracts/docs-prerender-tasks";

import {
  executePrerenderTask,
  type ExecutePrerenderTaskInput,
} from "./prerender-task";
import type { PrerenderTaskPayload } from "./task-contract";
import {
  PrerenderPermanentError,
  PrerenderTaskObsoleteError,
} from "./prerender-errors";

export {
  PrerenderPermanentError,
  PrerenderTaskObsoleteError,
} from "./prerender-errors";

const MAX_ERROR_MESSAGE_LENGTH = 500;

export type TaskFenceResult = PrerenderTaskFenceResult;
export type TaskEligibilityResult = PrerenderTaskEligibilityResult;
export type PrerenderExecutionResult = {
  status: "committed" | "already_complete";
  routeCount: number;
};

export type PrerenderTaskApi = Pick<
  PrerenderTaskApiRpc,
  "validate" | "heartbeat" | "complete" | "fail"
>;

export interface PrerenderWorkflowStep {
  validateTask(
    callback: () => Promise<TaskEligibilityResult>,
  ): Promise<TaskEligibilityResult>;
  renderAndCommit(
    callback: () => Promise<PrerenderExecutionResult>,
  ): Promise<PrerenderExecutionResult>;
  completeTask(
    callback: () => Promise<TaskFenceResult>,
  ): Promise<TaskFenceResult>;
}

interface PrerenderWorkflowRunnerDependencies {
  api: PrerenderTaskApi;
  execute: typeof executePrerenderTask;
  createExecutionInput(
    payload: PrerenderTaskPayload,
  ): Omit<ExecutePrerenderTaskInput, "onProgress">;
}

export class PrerenderWorkflowRunner {
  constructor(
    private readonly dependencies: PrerenderWorkflowRunnerDependencies,
  ) {}

  async run(
    payload: PrerenderTaskPayload,
    step: PrerenderWorkflowStep,
  ): Promise<{ status: "committed" | "already_complete"; routeCount: number }> {
    const eligibility = await step.validateTask(() =>
      this.dependencies.api.validate({
        taskId: payload.taskId,
        claimToken: payload.claimToken,
        identity: payload.identity,
      }),
    );
    if (eligibility.status !== "active") {
      throw new PrerenderTaskObsoleteError();
    }

    try {
      const result = await step.renderAndCommit(() =>
        this.dependencies.execute({
          ...this.dependencies.createExecutionInput(payload),
          onProgress: async (progress) => {
            const heartbeat = await this.dependencies.api.heartbeat({
              taskId: payload.taskId,
              claimToken: payload.claimToken,
              ...progress,
            });
            if (heartbeat.status === "stale") {
              throw new PrerenderTaskObsoleteError();
            }
          },
        }),
      );
      const completion = await step.completeTask(() =>
        this.dependencies.api.complete({
          taskId: payload.taskId,
          claimToken: payload.claimToken,
          routeCount: result.routeCount,
          outcome: result.status,
        }),
      );
      if (completion.status === "stale") {
        throw new PrerenderTaskObsoleteError();
      }
      return result;
    } catch (error) {
      if (error instanceof PrerenderTaskObsoleteError) throw error;
      const permanent = error instanceof PrerenderPermanentError;
      await this.dependencies.api
        .fail({
          taskId: payload.taskId,
          claimToken: payload.claimToken,
          errorCode: permanent ? "unsupported_output" : "prerender_failed",
          errorMessage: sanitizeErrorMessage(error),
          retryable: !permanent,
        })
        .catch(() => undefined);
      throw error;
    }
  }
}

function sanitizeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Pre-render task failed.";
  return message
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
