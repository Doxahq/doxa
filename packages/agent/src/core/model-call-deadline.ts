import type { ChatMiddleware } from "@tanstack/ai";

export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 120_000;
export const DEFAULT_MODEL_CALL_MAX_DURATION_MS = 600_000;

export type ModelCallTimeoutKind = "idle" | "max_duration";

export class ModelCallTimeoutError extends Error {
  readonly iteration: number;
  readonly timeoutMs: number;
  readonly kind: ModelCallTimeoutKind;

  constructor(
    timeoutMs: number,
    iteration: number,
    kind: ModelCallTimeoutKind = "idle",
  ) {
    super(kind === "idle"
      ? `Model call ${iteration} produced no output for ${timeoutMs}ms.`
      : `Model call ${iteration} exceeded the ${timeoutMs}ms maximum duration.`);
    this.name = "ModelCallTimeoutError";
    this.iteration = iteration;
    this.timeoutMs = timeoutMs;
    this.kind = kind;
  }
}

export interface ModelCallDeadline {
  readonly middleware: ChatMiddleware;
  cleanup(): void;
  timeoutError(): ModelCallTimeoutError | null;
}

export interface LinkedAbortController {
  readonly controller: AbortController;
  cleanup(): void;
}

export function createLinkedAbortController(
  parent?: AbortController,
): LinkedAbortController {
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parent?.signal.reason);
  };

  if (parent?.signal.aborted) {
    abortFromParent();
  } else {
    parent?.signal.addEventListener("abort", abortFromParent, {
      once: true,
    });
  }

  return {
    controller,
    cleanup() {
      parent?.signal.removeEventListener("abort", abortFromParent);
    },
  };
}

export function createModelCallDeadline(
  controller: AbortController,
  timeoutMs: number,
  maxDurationMs: number,
): ModelCallDeadline {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      "Model call timeout must be a positive finite number.",
    );
  }
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new RangeError(
      "Model call maximum duration must be a positive finite number.",
    );
  }

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
  let currentIteration = 0;
  let timedOut: ModelCallTimeoutError | null = null;

  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const clearMaxDurationTimer = () => {
    if (maxDurationTimer !== undefined) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = undefined;
    }
  };
  const cleanup = () => {
    clearIdleTimer();
    clearMaxDurationTimer();
  };
  const abortWithTimeout = (
    kind: ModelCallTimeoutKind,
    durationMs: number,
  ) => {
    if (timedOut !== null) return;
    timedOut = new ModelCallTimeoutError(
      durationMs,
      currentIteration,
      kind,
    );
    cleanup();
    controller.abort(timedOut);
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      abortWithTimeout("idle", timeoutMs);
    }, timeoutMs);
  };
  const startTimers = (iteration: number) => {
    cleanup();
    currentIteration = iteration + 1;
    armIdleTimer();
    maxDurationTimer = setTimeout(() => {
      abortWithTimeout("max_duration", maxDurationMs);
    }, maxDurationMs);
  };

  return {
    middleware: {
      name: "doxa-model-call-deadline",
      onIteration: (_context, info) => {
        startTimers(info.iteration);
      },
      onChunk: (_context, chunk) => {
        if (chunk.type === "RUN_FINISHED") {
          cleanup();
          return;
        }
        armIdleTimer();
      },
      onFinish: cleanup,
      onAbort: cleanup,
      onError: cleanup,
    },
    cleanup,
    timeoutError() {
      return timedOut;
    },
  };
}
