import { z } from "zod";

/**
 * Continuing a failed run from the Workflow step that failed. Every earlier
 * step keeps its result, so the plan and the written pages are not paid for
 * again. A new commit or new settings start a new run instead.
 */

/** On the run, when it stops: the step that failed and whether it can continue. */
export const WORKFLOW_STEP_FAILED_EVENT_TYPE = "workflow_step_failed";

/**
 * On a run that the credit meter stopped (`stopped_credits`, billing spec
 * 10.6): the step where it stopped, with the same data as
 * `workflow_step_failed`. A person can continue the run from there after
 * raising the cap or the monthly limit. The generation log does not show it;
 * the `credits_stopped` event tells people why the run stopped.
 */
export const GENERATION_CREDIT_STOP_STEP_EVENT_TYPE = "credits_stopped_step";

/** On the run, when a person continues it. The run's time budget starts again here. */
export const GENERATION_RESUMED_EVENT_TYPE = "generation_resumed";

export const workflowStepFailureSchema = z
  .object({
    stepName: z.string().min(1).max(256),
    /** 1-based occurrence of the step name in the run. */
    count: z.number().int().positive(),
    /**
     * False for a failure that a retry repeats: a stopped job, a refused
     * model account, too many failed pages, or a non-retryable step error.
     */
    resumable: z.boolean(),
  })
  .strict();

export type WorkflowStepFailure = z.infer<typeof workflowStepFailureSchema>;

/** Where the queue tells the worker to continue the run's Workflow instance. */
export const workflowRestartPointSchema = z
  .object({
    name: z.string().min(1).max(256),
    count: z.number().int().positive().optional(),
  })
  .strict();

export type WorkflowRestartPoint = z.infer<typeof workflowRestartPointSchema>;

/**
 * Days after a failure that a run can still continue. A failed Workflow
 * instance keeps its step results for 30 days (`errorRetention`); one day
 * less leaves room for the restart itself.
 */
export const GENERATION_RESUME_WINDOW_DAYS = 29;
