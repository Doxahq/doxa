type TimingLogger = Pick<Console, "info">;

export type RuntimeTimingLogData = Record<
  string,
  boolean | number | string | null | undefined
>;

export interface RuntimeTimingSink {
  enabled: boolean;
  mark(event: string, data?: RuntimeTimingLogData): void;
  measure<T>(
    event: string,
    operation: () => T | Promise<T>,
    data?: RuntimeTimingLogData
  ): Promise<T>;
}

export function isRuntimeTimingEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return isTruthyRuntimeFlag(env.DOXA_DOCS_RUNTIME_TIMING);
}

export function createRuntimeTimingSink(
  enabled: boolean,
  context: RuntimeTimingLogData = {},
  logger: TimingLogger = console
): RuntimeTimingSink {
  return {
    enabled,
    mark(event, data = {}) {
      if (!enabled) return;
      logRuntimeTiming(logger, event, context, data);
    },
    async measure(event, operation, data = {}) {
      if (!enabled) return operation();

      const startedAt = now();
      try {
        const result = await operation();
        logRuntimeTiming(logger, event, context, {
          ...data,
          ok: true,
          durationMs: elapsed(startedAt),
        });
        return result;
      } catch (error) {
        logRuntimeTiming(logger, event, context, {
          ...data,
          ok: false,
          durationMs: elapsed(startedAt),
          errorName:
            error instanceof Error ? error.name || "Error" : "UnknownError",
        });
        throw error;
      }
    },
  };
}

export function now(): number {
  return Date.now();
}

export function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export function estimateJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function isTruthyRuntimeFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function logRuntimeTiming(
  logger: TimingLogger,
  event: string,
  context: RuntimeTimingLogData,
  data: RuntimeTimingLogData
): void {
  logger.info(
    "[doxa-docs-renderer:timing]",
    JSON.stringify({
      event,
      ...context,
      ...data,
    })
  );
}
