import type { Env } from "../../env";
import { DocsSearchIndexesRepository } from "../../repositories/docs-search-indexes";
import { abortable } from "./abortable";
import {
  DOCS_SEARCH_RUN_BUDGET_MS,
  DOCS_SEARCH_SWEEP_BUDGET_MS,
  DOCS_SEARCH_TASK_BUDGET_MS,
} from "./limits";
import { rollUpSearchUsage } from "./usage-rollup";
import { createDocsSearchIndexWorker } from "./worker-factory";

const USAGE_ROLLUP_EVERY_MS = 60 * 60 * 1000;
const CRON_TICK_MS = 5 * 60 * 1000;

export interface DocsSearchMaintenanceSteps {
  sweep(signal: AbortSignal): Promise<void>;
  runTasks(signal: AbortSignal): Promise<unknown>;
  recheck(signal: AbortSignal): Promise<unknown>;
  rollUpUsage(signal: AbortSignal): Promise<void>;
}

/**
 * One budget covers the whole run, because the cron handler waits for every job:
 * when it ends, this job ends, even if a read or a database call never answers.
 * The sweep, the tasks and the rechecks each have a part that the step before
 * cannot take, and each deadline counts from the start of the run. So one stalled
 * step cannot starve the steps after it.
 */
export function runMaintenanceSteps(
  steps: DocsSearchMaintenanceSteps,
  budgets: { runMs: number; sweepMs: number; taskMs: number } = {
    runMs: DOCS_SEARCH_RUN_BUDGET_MS,
    sweepMs: DOCS_SEARCH_SWEEP_BUDGET_MS,
    taskMs: DOCS_SEARCH_TASK_BUDGET_MS,
  },
): Promise<void> {
  const signal = AbortSignal.timeout(budgets.runMs);
  const sweepSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(budgets.sweepMs),
  ]);
  const taskSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(budgets.taskMs),
  ]);
  const inOrder = async () => {
    await waitWithin("sweep", steps.sweep(sweepSignal), sweepSignal);
    await waitWithin("tasks", steps.runTasks(taskSignal), taskSignal);
    await steps.recheck(signal);
    await steps.rollUpUsage(signal);
  };
  return abortable(inOrder(), signal);
}

/**
 * Waits for a step until its deadline, then moves on. The step can still fail
 * after that, when nobody waits for it, so that failure goes to the log.
 */
function waitWithin(
  step: string,
  work: Promise<unknown>,
  deadline: AbortSignal,
): Promise<unknown> {
  const logged = work.catch((error: unknown) => {
    if (deadline.aborted) {
      console.warn(
        JSON.stringify({
          event: "docs_search_late_failure",
          step,
          errorClass: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
    throw error;
  });
  return abortable(logged, deadline).catch((error: unknown) => {
    if (!deadline.aborted) throw error;
  });
}

/** The scheduled part of docs search. */
export function runDocsSearchMaintenance(
  scheduledTime: number,
  env: Env,
): Promise<void> {
  const indexes = new DocsSearchIndexesRepository(env);
  const worker = createDocsSearchIndexWorker(env);
  return runMaintenanceSteps({
    sweep: (signal) => indexes.sweep(signal),
    runTasks: (signal) => worker.run(undefined, signal),
    recheck: (signal) => worker.reconcile(signal),
    rollUpUsage: async (signal) => {
      const accountId = env.SEARCH_USAGE_ACCOUNT_ID;
      const apiToken = env.SEARCH_USAGE_API_TOKEN;
      if (!accountId || !apiToken) return;
      if (scheduledTime % USAGE_ROLLUP_EVERY_MS >= CRON_TICK_MS) return;
      await rollUpSearchUsage({
        accountId,
        apiToken,
        now: scheduledTime,
        save: (rows) => indexes.saveUsage(rows),
        signal,
      });
    },
  });
}
