import type { GenerationStopReason } from "@doxahq/contracts";

/** Stops a workflow step without a retry. The step adapter turns it into the Workflows `NonRetryableError`. */
export class GenerationNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationNonRetryableError";
  }
}

const CREDIT_STOP_TEXT: Record<GenerationStopReason, string> = {
  credits_exhausted: "the account's AI credits ran out",
  credit_cap: "the run reached its credit cap",
};

/**
 * Billing spec 10.5 step 4: the credit meter stopped the run. The worker
 * starts no new model call, lets the calls in flight finish, and ends the job
 * as `stopped_credits` with its finished page checkpoints kept. The message
 * carries the reason, because a Workflow step error keeps only its message.
 */
export class GenerationCreditsStoppedError extends GenerationNonRetryableError {
  constructor(readonly reason: GenerationStopReason) {
    super(`Generation stopped for credits (${reason}): ${CREDIT_STOP_TEXT[reason]}.`);
    this.name = "GenerationCreditsStoppedError";
  }
}

const CREDIT_STOP_MESSAGE = /generation stopped for credits \((credits_exhausted|credit_cap)\)/i;

/** The credit stop reason of an error, also after a step turned it into another error class. */
export function creditStopReasonOf(error: unknown): GenerationStopReason | null {
  if (error instanceof GenerationCreditsStoppedError) return error.reason;
  const message = error instanceof Error ? error.message : String(error);
  const match = CREDIT_STOP_MESSAGE.exec(message);
  return match ? (match[1]?.toLowerCase() as GenerationStopReason) : null;
}

/** The text of a job that the credit meter stopped. */
export function creditStopMessage(reason: GenerationStopReason): string {
  return `Doxa stopped the run because ${CREDIT_STOP_TEXT[reason]}. Finished pages are kept.`;
}
