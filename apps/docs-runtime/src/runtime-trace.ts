import type {
  DocsRuntimeCallTiming,
  DocsRuntimeIsolateFacts,
  DocsRuntimeTrace,
} from "@doxahq/contracts/docs-runtime-trace";

/**
 * Facts about this docs-runtime isolate for traced calls (M39).
 *
 * Workers forbid random values at global scope, so the first runtime call
 * creates the ID and the start time. `requests` counts the runtime
 * operations that this isolate ran, including the ones that site assets run.
 */
interface IsolateFacts {
  id: string;
  startedAt: number;
  requests: number;
}

/** How many version IDs the isolate remembers for `versionColdInIsolate`. */
const SEEN_VERSIONS_CAPACITY = 1_000;

let isolate: IsolateFacts | undefined;
const seenVersions = new Set<string>();

/** Counts one runtime call and returns the isolate facts as one call sees them. */
export function recordIsolateRequest(
  now: number = Date.now(),
  createId: () => string = () => crypto.randomUUID(),
): DocsRuntimeIsolateFacts {
  isolate ??= { id: createId(), startedAt: now, requests: 0 };
  isolate.requests += 1;
  return {
    id: isolate.id,
    requests: isolate.requests,
    ageMs: Math.max(0, now - isolate.startedAt),
  };
}

/**
 * Returns true for the first call for this version in this isolate. The
 * set is bounded: when it is full, the oldest version is forgotten.
 */
export function markVersionSeen(publishedVersionId: string): boolean {
  if (seenVersions.has(publishedVersionId)) return false;
  if (seenVersions.size >= SEEN_VERSIONS_CAPACITY) {
    const oldest = seenVersions.values().next();
    if (!oldest.done) seenVersions.delete(oldest.value);
  }
  seenVersions.add(publishedVersionId);
  return true;
}

export function resetRuntimeTraceStateForTests(): void {
  isolate = undefined;
  seenVersions.clear();
}

/** What one traced call measured. Durations are wall-clock milliseconds. */
export interface RuntimeCallMeasurements {
  startedAt: number;
  finishedAt: number;
  manifestMs: number;
  operationMs: number;
  /** When the first storage read ended, if the call read storage. */
  firstReadEndedAt?: number;
  reads: number;
  r2Reads: number;
  readMs: number;
  responseBytes?: number;
  versionColdInIsolate: boolean;
  isolate: DocsRuntimeIsolateFacts;
}

export function toCallTiming(
  measured: RuntimeCallMeasurements,
): DocsRuntimeCallTiming {
  return {
    manifestMs: round(measured.manifestMs),
    operationMs: round(measured.operationMs),
    ...(measured.firstReadEndedAt !== undefined
      ? {
          firstReadMs: round(
            Math.max(0, measured.firstReadEndedAt - measured.startedAt),
          ),
        }
      : {}),
    totalMs: round(Math.max(0, measured.finishedAt - measured.startedAt)),
    reads: measured.reads,
    r2Reads: measured.r2Reads,
    readMs: round(measured.readMs),
    ...(measured.responseBytes !== undefined
      ? { responseBytes: measured.responseBytes }
      : {}),
    versionColdInIsolate: measured.versionColdInIsolate,
    isolate: measured.isolate,
  };
}

/** The trace fields of a `docs_runtime_reads` line; empty for an untraced call. */
export function traceLogFields(
  trace: DocsRuntimeTrace | undefined,
): { traceId: string; caller: DocsRuntimeTrace["caller"] } | Record<string, never> {
  return trace ? { traceId: trace.id, caller: trace.caller } : {};
}

function round(value: number): number {
  return Math.round(value);
}
