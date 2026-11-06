import { assertPageFailureBudget, type FailedGenerationPage } from "./generation-page-failures";
import type { GenerationWorkflowStep } from "./generation-workflow-runtime";

/** Workflows retry settings for a step that must run at most once. */
export const NO_STEP_RETRIES = {
  limit: 0,
  delay: "1 minute",
  backoff: "constant",
} as const;

/**
 * Runs a step whose work only adds information or steers later runs. It runs
 * once, so its effects never repeat, and a failure, a timeout included, gives
 * the fallback instead of failing the run.
 */
export async function runBestEffortStep<T>(input: {
  step: GenerationWorkflowStep;
  name: string;
  config: { retries: typeof NO_STEP_RETRIES; timeout: number };
  fallback: T;
  work: () => Promise<T>;
  onError: (error: unknown) => void;
}): Promise<T> {
  try {
    return await input.step.do(input.name, input.config, input.work);
  } catch (error) {
    input.onError(error);
    return input.fallback;
  }
}

/**
 * The end of a write phase, in an order that keeps what each part needs: the
 * catch-up ledger first, so a run that stops on its page failure budget still
 * counts its catch-up failures, then the budget, then the notices, which only
 * a run that goes on records.
 */
export async function settleWritePhase(input: {
  recordCatchUp: () => Promise<string[]>;
  checkPageFailureBudget: () => Promise<void>;
  recordNotices: (exhaustedPageIds: readonly string[]) => Promise<void>;
}): Promise<string[]> {
  const exhaustedPageIds = await input.recordCatchUp();
  await input.checkPageFailureBudget();
  await input.recordNotices(exhaustedPageIds);
  return exhaustedPageIds;
}

/**
 * The page failure budget in a step of its own, so a run that it stops names
 * the step it stopped at, like any other failed step. The step has no other
 * effect: it throws the budget error or returns.
 */
export async function checkPageFailureBudgetStep(input: {
  step: GenerationWorkflowStep;
  name: string;
  config: Parameters<GenerationWorkflowStep["do"]>[1];
  budgeted: { failedPages: readonly FailedGenerationPage[]; plannedCount: number };
}): Promise<void> {
  await input.step.do(input.name, input.config, async () => {
    assertPageFailureBudget(input.budgeted.failedPages, input.budgeted.plannedCount);
  });
}
