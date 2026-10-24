export const DEFAULT_PAGE_FAILURE_MAX_RETRIES = 1;
export const DEFAULT_DOCS_QUALITY_MAX_REPAIRS = 3;
export const DEFAULT_DOCS_QUALITY_MAX_REPAIRS_PER_PAGE = 2;

function assertRetryBudget(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

export function canRetryPageFailure(
  completedRetries: number,
  maxRetries = DEFAULT_PAGE_FAILURE_MAX_RETRIES,
): boolean {
  assertRetryBudget(completedRetries, "Completed page retries");
  assertRetryBudget(maxRetries, "Page retry budget");
  return completedRetries < maxRetries;
}

export function canRunDocsQualityRepair(
  completedRepairs: number,
  maxRepairs = DEFAULT_DOCS_QUALITY_MAX_REPAIRS,
): boolean {
  assertRetryBudget(completedRepairs, "Completed docs quality repairs");
  assertRetryBudget(maxRepairs, "Docs quality repair budget");
  return completedRepairs < maxRepairs;
}

export function canRunDocsQualityRepairForPage(
  completedRepairs: number,
  maxRepairs = DEFAULT_DOCS_QUALITY_MAX_REPAIRS_PER_PAGE,
): boolean {
  assertRetryBudget(completedRepairs, "Completed page quality repairs");
  assertRetryBudget(maxRepairs, "Per-page docs quality repair budget");
  return completedRepairs < maxRepairs;
}
