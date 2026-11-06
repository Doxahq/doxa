import {
  REPOSITORY_INSTRUCTIONS_REFUSED_MESSAGE,
  REPOSITORY_INSTRUCTIONS_UNAVAILABLE_MESSAGE,
} from "@doxahq/contracts";

/** The job event of a run whose generation context could not be loaded. */
export const GENERATION_CONTEXT_UNAVAILABLE_EVENT_TYPE = "generation_context_unavailable";

const GENERIC_CONTEXT_FAILURE_MESSAGE =
  "Doxa could not load the settings for this generation. Try again later.";

/** Messages that the owner may see. An error that crosses the service binding keeps its message but not its class. */
const KNOWN_CONTEXT_FAILURE_MESSAGES = [
  REPOSITORY_INSTRUCTIONS_REFUSED_MESSAGE,
  REPOSITORY_INSTRUCTIONS_UNAVAILABLE_MESSAGE,
] as const;

/**
 * What the owner sees when the generation context could not be loaded. Only
 * a known message passes through: any other error can hold internal detail,
 * such as a database error, so it becomes a generic message.
 */
export function executionContextFailureMessage(error: unknown): string {
  const message = errorMessage(error);
  return KNOWN_CONTEXT_FAILURE_MESSAGES.find((known) => message.includes(known))
    ?? GENERIC_CONTEXT_FAILURE_MESSAGE;
}

/** True when trying the context again cannot help: GitHub refused the repository file. */
export function isPermanentContextFailure(error: unknown): boolean {
  return errorMessage(error).includes(REPOSITORY_INSTRUCTIONS_REFUSED_MESSAGE);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
