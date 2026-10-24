/**
 * Shared eligibility rule for generation baselines after an operator clears a
 * project's generation cache.
 *
 * Clearing records an instant on the docs site rather than deleting anything:
 * published docs keep serving, and every version produced at or before that
 * instant simply stops qualifying as a reuse baseline. The next generation
 * therefore analyzes from scratch, and the version it publishes is created
 * after the reset, so reuse resumes on its own without a second action.
 */
export interface GenerationBaselineResetState {
  versionCreatedAt: Date;
  generationBaselineResetAt: Date | null;
}

export function isClearedGenerationBaseline(
  candidate: GenerationBaselineResetState,
): boolean {
  if (!candidate.generationBaselineResetAt) {
    return false;
  }

  // Inclusive: a version created in the same instant as the reset is treated as
  // pre-reset, so clearing can never leave a stale baseline behind.
  return (
    candidate.versionCreatedAt.getTime() <=
      candidate.generationBaselineResetAt.getTime()
  );
}
