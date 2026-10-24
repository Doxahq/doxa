/** One kind of write group: its pages, its group size and the timeout of one group. */
export interface WriteGroupBudget {
  pageCount: number;
  /** Pages in one write batch, which is one Workflow step. */
  pagesPerBatch: number;
  pageBatchTimeoutMs: number;
}

export interface WritingStageBudgetInput extends WriteGroupBudget {
  /** Number of write batches dispatched in parallel. Default 1. */
  batchParallelism?: number;
  /**
   * Template-rendered pages, when the caller writes them in their own,
   * larger groups. `pageCount` then counts only the model-written pages.
   */
  templatePages?: WriteGroupBudget;
}

export interface GenerationFeasibilityInput extends WritingStageBudgetInput {
  elapsedMs: number;
  overallTimeoutMs: number;
  finalizationTimeoutMs: number;
}

export interface GenerationFeasibility {
  feasible: boolean;
  batchCount: number;
  remainingMs: number;
  requiredMs: number;
}

export function planPageBatches(pageIds: readonly string[], pagesPerBatch: number): string[][] {
  assertPositiveInteger(pagesPerBatch, "Pages per batch");

  const batches: string[][] = [];
  for (let index = 0; index < pageIds.length; index += pagesPerBatch) {
    batches.push(pageIds.slice(index, index + pagesPerBatch));
  }
  return batches;
}

/**
 * The longest the write stage can take: the batch waves of the model pages,
 * then the batch waves of the template pages, each wave one batch timeout.
 */
export function writingStageTimeoutMs(input: WritingStageBudgetInput): number {
  const batchParallelism = input.batchParallelism ?? 1;
  assertPositiveInteger(batchParallelism, "Batch parallelism");

  return writeGroupBudgets(input).reduce(
    (totalMs, group) =>
      totalMs + Math.ceil(batchCountOf(group) / batchParallelism) * group.pageBatchTimeoutMs,
    0,
  );
}

export function assessGenerationFeasibility(input: GenerationFeasibilityInput): GenerationFeasibility {
  assertNonNegativeDuration(input.elapsedMs, "Elapsed duration");
  assertPositiveDuration(input.overallTimeoutMs, "Overall timeout");
  assertPositiveDuration(input.finalizationTimeoutMs, "Finalization timeout");

  const writingMs = writingStageTimeoutMs(input);
  const batchCount = writeGroupBudgets(input).reduce(
    (total, group) => total + batchCountOf(group),
    0,
  );
  const remainingMs = Math.max(0, input.overallTimeoutMs - input.elapsedMs);
  const requiredMs = writingMs + input.finalizationTimeoutMs;

  return {
    feasible: requiredMs <= remainingMs,
    batchCount,
    remainingMs,
    requiredMs,
  };
}

function writeGroupBudgets(input: WritingStageBudgetInput): WriteGroupBudget[] {
  const groups = input.templatePages ? [input, input.templatePages] : [input];
  for (const group of groups) {
    assertNonNegativeInteger(group.pageCount, "Page count");
    assertPositiveInteger(group.pagesPerBatch, "Pages per batch");
    assertPositiveDuration(group.pageBatchTimeoutMs, "Page batch timeout");
  }
  return groups;
}

function batchCountOf(group: WriteGroupBudget): number {
  return Math.ceil(group.pageCount / group.pagesPerBatch);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive duration.`);
  }
}

function assertNonNegativeDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative duration.`);
  }
}
