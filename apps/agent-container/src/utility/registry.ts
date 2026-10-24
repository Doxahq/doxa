import { SPEC_READER_JOB } from "@doxahq/contracts/spec-reader";

/** The port that the supervisor of every job image listens on. */
export const UTILITY_JOB_PORT = 8790;

/** The host that the agent container calls; only the gate answers it. */
export const UTILITY_HOST = "utility.internal";

/** The network a job may use. Every job today has none. */
export type UtilityJobNetwork = "none";

export type UtilityJobBinding = "UTILITY_SPEC_READER";

export interface UtilityJobDefinition {
  /** The Durable Object binding of the job's own container class. */
  binding: UtilityJobBinding;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** One call, the cold start included. */
  timeoutMs: number;
  network: UtilityJobNetwork;
}

/**
 * Every utility job. Each one has its own image with only its own code,
 * its own container class and its own limits. A job that is not here
 * does not exist for the gate.
 */
export const UTILITY_JOBS = {
  [SPEC_READER_JOB.name]: {
    binding: "UTILITY_SPEC_READER",
    maxRequestBytes: SPEC_READER_JOB.maxRequestBytes,
    maxResponseBytes: SPEC_READER_JOB.maxOutputBytes,
    timeoutMs: SPEC_READER_JOB.callTimeoutMs,
    network: "none",
  },
} as const satisfies Record<string, UtilityJobDefinition>;

export type UtilityJobName = keyof typeof UTILITY_JOBS;

export function isUtilityJobName(name: string): name is UtilityJobName {
  return Object.hasOwn(UTILITY_JOBS, name);
}
