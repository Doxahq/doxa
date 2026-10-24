import type { WorkflowStepFailure } from "@doxahq/contracts";
import { isRunStoppingError } from "./generation-page-failures";
import type { GenerationWorkflowStep } from "./generation-workflow-runtime";

/**
 * Remembers the Workflow steps that failed after their retries, so a failed
 * run can later continue from the step that ended it, with
 * `instance.restart({ from })`. Step names are deterministic, so the same
 * name finds the same step.
 */
export interface WorkflowStepTracker {
  readonly step: GenerationWorkflowStep;
  /**
   * The step whose error ended the run, or null when the run failed outside
   * any step. A step can fail without ending the run, like a write batch
   * whose pages are flagged, so the step is found by the run's error.
   */
  failureOf(runError: unknown): WorkflowStepFailure | null;
}

/** Messages of failures that a second try repeats exactly. */
const FINAL_FAILURE_MESSAGE =
  /pages could not be written, so the run stopped|database schema is incompatible|invalid checkpoint/i;

export function isResumableStepError(error: unknown): boolean {
  if (error instanceof Error && error.name === "NonRetryableError") return false;
  const message = error instanceof Error ? error.message : String(error);
  return !isRunStoppingError(error) && !FINAL_FAILURE_MESSAGE.test(message);
}

interface FailedStep {
  failure: WorkflowStepFailure;
  error: unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function trackWorkflowSteps(step: GenerationWorkflowStep): WorkflowStepTracker {
  const occurrences = new Map<string, number>();
  const failedSteps: FailedStep[] = [];

  return {
    step: {
      async do(name, config, callback) {
        const count = (occurrences.get(name) ?? 0) + 1;
        occurrences.set(name, count);
        try {
          return await step.do(name, config, callback);
        } catch (error) {
          failedSteps.push({
            failure: { stepName: name, count, resumable: isResumableStepError(error) },
            error,
          });
          throw error;
        }
      },
    },
    failureOf(runError) {
      const match = failedSteps.find(({ error }) => error === runError) ??
        [...failedSteps].reverse().find(({ error }) => messageOf(error) === messageOf(runError));
      return match?.failure ?? null;
    },
  };
}
