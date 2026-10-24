import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StageTimingSummary } from "./stage-timings";

const SAFE_LOG_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOG_DIRECTORY_SEGMENTS = [".artifacts", "generation-performance-logs"];
const PERFORMANCE_EVENT_TYPE = "generation_performance_summary";

/**
 * One durable performance sample for a single stage execution.
 *
 * Performance telemetry deliberately stays out of the customer-facing job
 * event stream: it is operator diagnostics, and the dashboard truncates event
 * payloads well before the fields that matter here.
 */
export interface GenerationPerformanceRecord {
  jobId: string;
  stageExecutionId: string;
  recordedAt: string;
  /** Owns the stage name, so it is never duplicated on the record. */
  summary: StageTimingSummary;
}

export interface GenerationPerformanceLogOptions {
  /** Overrides the resolved `.artifacts` destination. */
  directory?: string;
  /** Writes one NDJSON line. Defaults to appending to the job's log file. */
  appendLine?: (filePath: string, line: string) => Promise<void>;
  /** Receives the same line on stdout. Defaults to `console.log`. */
  writeStdout?: (line: string) => void;
  /** Receives non-fatal persistence failures. Defaults to `console.error`. */
  writeStderr?: (line: string) => void;
}

/**
 * Resolves the performance log directory.
 *
 * `DOXA_PERFORMANCE_LOG_DIR` wins so hosted containers can redirect the file
 * somewhere writable. The default matches the repository convention used by
 * the synthetic generation harness.
 */
export function resolveGenerationPerformanceLogDirectory(
  environment: Record<string, string | undefined> = process.env,
): string {
  const configured = environment.DOXA_PERFORMANCE_LOG_DIR?.trim();
  if (configured) return resolve(configured);

  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  return join(repositoryRoot, ...LOG_DIRECTORY_SEGMENTS);
}

/**
 * Writes one stage performance sample to stdout and to the job's NDJSON log.
 *
 * Never throws: diagnostics must not fail a paid generation.
 */
export async function recordGenerationPerformance(
  record: GenerationPerformanceRecord,
  options: GenerationPerformanceLogOptions = {},
): Promise<void> {
  const line = JSON.stringify({
    service: "doxa-agent-container",
    eventType: PERFORMANCE_EVENT_TYPE,
    jobId: record.jobId,
    stageExecutionId: record.stageExecutionId,
    recordedAt: record.recordedAt,
    ...record.summary,
  });

  (options.writeStdout ?? defaultWriteStdout)(line);

  try {
    const directory = options.directory
      ?? resolveGenerationPerformanceLogDirectory();
    const filePath = join(directory, `${logFileName(record.jobId)}.jsonl`);
    await mkdir(directory, { recursive: true });
    await (options.appendLine ?? defaultAppendLine)(filePath, line);
  } catch (error) {
    (options.writeStderr ?? defaultWriteStderr)(JSON.stringify({
      service: "doxa-agent-container",
      eventType: "generation_performance_log_failed",
      jobId: record.jobId,
      stage: record.summary.stage,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

function logFileName(jobId: string): string {
  return SAFE_LOG_SEGMENT.test(jobId) ? jobId : "unknown-job";
}

function defaultAppendLine(filePath: string, line: string): Promise<void> {
  return appendFile(filePath, `${line}\n`, "utf8");
}

function defaultWriteStdout(line: string): void {
  console.log(line);
}

function defaultWriteStderr(line: string): void {
  console.error(line);
}
