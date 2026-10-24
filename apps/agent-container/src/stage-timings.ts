import type {
  AgentSpanCallback,
  AgentSpanRecord,
  ResolvedWriterExplorationMode,
} from "@doxahq/agent";

interface OperationTiming {
  calls: number;
  ms: number;
}

export interface StageTimingSummary {
  stage: string;
  wallMs: number;
  snapshotMs: number;
  modelMs: number;
  modelCalls: number;
  toolMs: number;
  toolCalls: number;
  validationMs: number;
  validationCalls: number;
  busyMs: number;
  peakConcurrentModelSpans: number;
  peakConcurrentToolSpans: number;
  peakConcurrentValidationSpans: number;
  evidenceFirstPages: number;
  agenticFallbackPages: number;
  unattributedMs: number;
  slowestModelCallMs: number;
  byOperation: Record<string, OperationTiming>;
}

export interface StageTimings {
  onSpan: AgentSpanCallback;
  markSnapshot(durationMs: number): void;
  markWriterExploration(mode: ResolvedWriterExplorationMode): void;
  summarize(): StageTimingSummary;
}

export function createStageTimings(stage: string): StageTimings {
  const startedAt = Date.now();
  const spans: AgentSpanRecord[] = [];
  let snapshotMs = 0;
  let evidenceFirstPages = 0;
  let agenticFallbackPages = 0;

  return {
    onSpan: (span) => {
      spans.push(normalizeSpan(span));
    },
    markSnapshot: (durationMs) => {
      snapshotMs += normalizeDuration(durationMs);
    },
    markWriterExploration: (mode) => {
      if (mode === "evidence_first") {
        evidenceFirstPages += 1;
      } else {
        agenticFallbackPages += 1;
      }
    },
    summarize: () => summarizeStageTimings(
      stage,
      Math.max(0, Date.now() - startedAt),
      snapshotMs,
      spans,
      evidenceFirstPages,
      agenticFallbackPages,
    ),
  };
}

function summarizeStageTimings(
  stage: string,
  wallMs: number,
  snapshotMs: number,
  spans: readonly AgentSpanRecord[],
  evidenceFirstPages: number,
  agenticFallbackPages: number,
): StageTimingSummary {
  const modelSpans = spans.filter((span) => span.kind === "model");
  const toolSpans = spans.filter((span) => span.kind === "tool");
  const validationSpans = spans.filter((span) => span.kind === "validation");
  const modelMs = sumDurations(modelSpans);
  const toolMs = sumDurations(toolSpans);
  const validationMs = sumDurations(validationSpans);
  const busyMs = summarizeBusyTime(spans);

  return {
    stage,
    wallMs,
    snapshotMs,
    modelMs,
    modelCalls: modelSpans.length,
    toolMs,
    toolCalls: toolSpans.length,
    validationMs,
    validationCalls: validationSpans.length,
    busyMs,
    peakConcurrentModelSpans: peakSpanConcurrency(modelSpans),
    peakConcurrentToolSpans: peakSpanConcurrency(toolSpans),
    peakConcurrentValidationSpans: peakSpanConcurrency(validationSpans),
    evidenceFirstPages,
    agenticFallbackPages,
    unattributedMs: Math.max(0, wallMs - snapshotMs - busyMs),
    slowestModelCallMs: modelSpans.reduce(
      (slowest, span) => Math.max(slowest, span.durationMs),
      0,
    ),
    byOperation: groupByOperation(spans),
  };
}

function normalizeSpan(span: AgentSpanRecord): AgentSpanRecord {
  const startedAt = normalizeTimestamp(span.startedAt);
  const endedAt = Math.max(startedAt, normalizeTimestamp(span.endedAt));
  return {
    ...span,
    startedAt,
    endedAt,
    durationMs: normalizeDuration(span.durationMs),
  };
}

function normalizeTimestamp(timestamp: number): number {
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function normalizeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}

function sumDurations(spans: readonly AgentSpanRecord[]): number {
  return spans.reduce((total, span) => total + span.durationMs, 0);
}

function summarizeBusyTime(
  spans: readonly AgentSpanRecord[],
): number {
  const intervals = spans
    .filter((span) => span.endedAt > span.startedAt)
    .map((span) => ({
      startedAt: span.startedAt,
      endedAt: span.endedAt,
    }))
    .sort((left, right) =>
      left.startedAt - right.startedAt || left.endedAt - right.endedAt
    );
  let busyMs = 0;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;
  for (const interval of intervals) {
    if (currentStart === undefined || currentEnd === undefined) {
      currentStart = interval.startedAt;
      currentEnd = interval.endedAt;
      continue;
    }
    if (interval.startedAt > currentEnd) {
      busyMs += currentEnd - currentStart;
      currentStart = interval.startedAt;
      currentEnd = interval.endedAt;
      continue;
    }
    currentEnd = Math.max(currentEnd, interval.endedAt);
  }
  if (currentStart !== undefined && currentEnd !== undefined) {
    busyMs += currentEnd - currentStart;
  }
  return busyMs;
}

function peakSpanConcurrency(
  spans: readonly AgentSpanRecord[],
): number {
  const intervals = spans
    .filter((span) => span.endedAt > span.startedAt)
    .map((span) => ({
      startedAt: span.startedAt,
      endedAt: span.endedAt,
    }));
  const events = intervals
    .flatMap((interval) => [
      { at: interval.startedAt, delta: 1 },
      { at: interval.endedAt, delta: -1 },
    ])
    .sort((left, right) => left.at - right.at || left.delta - right.delta);
  let concurrentSpans = 0;
  let peak = 0;
  for (const event of events) {
    concurrentSpans += event.delta;
    peak = Math.max(peak, concurrentSpans);
  }
  return peak;
}

function groupByOperation(
  spans: readonly AgentSpanRecord[],
): Record<string, OperationTiming> {
  const byOperation: Record<string, OperationTiming> = {};
  for (const span of spans) {
    const operation = span.kind === "model"
      ? span.context?.operation ?? span.name
      : span.name;
    const current = byOperation[operation] ?? { calls: 0, ms: 0 };
    byOperation[operation] = {
      calls: current.calls + 1,
      ms: current.ms + span.durationMs,
    };
  }
  return byOperation;
}
