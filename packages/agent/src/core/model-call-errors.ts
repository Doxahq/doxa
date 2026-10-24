/**
 * Core Agent Library - Model call errors
 * Sorts a failed model call into a provider-neutral class, which decides
 * whether the call retries, whether the page retries, and whether the whole
 * run stops.
 */

import {
  isRunStoppingModelErrorMessage,
  modelProviderErrorMessage,
  RUN_STOPPING_MODEL_ERROR_CLASSES,
  type ModelCallErrorClass,
} from "@doxahq/contracts";
import { runErrorMessage } from "./provider-errors";

export type { ModelCallErrorClass };

const STOPS_RUN: ReadonlySet<ModelCallErrorClass> = new Set(RUN_STOPPING_MODEL_ERROR_CLASSES);

export interface ModelCallErrorClassPolicy {
  /** The same request can succeed after a wait. */
  retryable: boolean;
  /** Every other call of the run fails the same way, so the run stops. */
  stopsRun: boolean;
}

const RETRYABLE: ReadonlySet<ModelCallErrorClass> = new Set([
  "rate_limited",
  "overloaded",
  "server_error",
  "timeout",
]);

/**
 * What a class means for a call. Rate limits, overloads, server errors and
 * timeouts retry; a spend cap, a bad key or a missing model stop the run;
 * the rest fail only their page.
 */
export function modelCallErrorPolicy(errorClass: ModelCallErrorClass): ModelCallErrorClassPolicy {
  return { retryable: RETRYABLE.has(errorClass), stopsRun: STOPS_RUN.has(errorClass) };
}

/** A failed model call with its class. The message names the class first. */
export class ModelCallError extends Error {
  readonly errorClass: ModelCallErrorClass;
  readonly status: number | undefined;

  constructor(errorClass: ModelCallErrorClass, detail: string, status?: number) {
    super(modelProviderErrorMessage(errorClass, detail));
    this.name = "ModelCallError";
    this.errorClass = errorClass;
    this.status = status;
  }

  get retryable(): boolean {
    return modelCallErrorPolicy(this.errorClass).retryable;
  }

  get stopsRun(): boolean {
    return modelCallErrorPolicy(this.errorClass).stopsRun;
  }
}

export function isRunStoppingModelError(error: unknown): boolean {
  if (error instanceof ModelCallError) return error.stopsRun;
  return isRunStoppingModelErrorMessage(error instanceof Error ? error.message : String(error));
}

interface RunErrorChunk {
  message?: unknown;
  code?: unknown;
  error?: { message?: unknown; code?: unknown };
  rawEvent?: unknown;
}

const SPEND_CAP_PATTERN = /credit balance|insufficient credits|spend(?:ing)? limit|usage limit|billing|quota/i;

/**
 * The class of a failed call from its status code and message. Providers
 * that need more can classify first; this is the shared fallback.
 */
export function classifyModelCallFailure(
  status: number | undefined,
  message: string,
): ModelCallErrorClass {
  if (SPEND_CAP_PATTERN.test(message) && (status === undefined || [400, 402, 403, 429].includes(status))) {
    return "spend_cap";
  }
  if (/overloaded/i.test(message)) return "overloaded";
  switch (status) {
    case 401:
    case 403:
      return "auth";
    case 402:
      return "spend_cap";
    case 404:
      return "model_not_found";
    case 408:
      return "timeout";
    case 413:
      return "too_large";
    case 429:
      return "rate_limited";
    case 529:
      return "overloaded";
    case 500:
    case 502:
    case 503:
    case 504:
      return "server_error";
    case 400:
    case 422:
      return "invalid_request";
    default:
      return "unknown";
  }
}

function statusOf(chunk: RunErrorChunk): number | undefined {
  for (const value of [chunk.code, chunk.error?.code]) {
    const status = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return undefined;
}

/** The typed error for a TanStack `RUN_ERROR` chunk. */
export function modelCallErrorFromChunk(chunk: RunErrorChunk): ModelCallError {
  const message = runErrorMessage(chunk);
  const status = statusOf(chunk);
  return new ModelCallError(classifyModelCallFailure(status, message), message, status);
}
