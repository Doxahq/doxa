import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  recordGenerationPerformance,
  resolveGenerationPerformanceLogDirectory,
  type GenerationPerformanceRecord,
} from "../src/performance-log";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("generation performance log", () => {
  test("writes one NDJSON line to stdout and the job log file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doxa-perf-log-"));
    temporaryDirectories.push(directory);
    const stdout: string[] = [];

    await recordGenerationPerformance(performanceRecord(), {
      directory,
      writeStdout: (line) => stdout.push(line),
    });
    const writeRecord = performanceRecord();
    await recordGenerationPerformance(
      { ...writeRecord, summary: { ...writeRecord.summary, stage: "write" } },
      { directory, writeStdout: (line) => stdout.push(line) },
    );

    const logPath = join(
      directory,
      "11111111-1111-4111-8111-111111111111.jsonl",
    );
    const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");

    expect(stdout).toHaveLength(2);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      service: "doxa-agent-container",
      eventType: "generation_performance_summary",
      jobId: "11111111-1111-4111-8111-111111111111",
      stage: "analysis",
      busyMs: 120,
      peakConcurrentModelSpans: 2,
      evidenceFirstPages: 3,
    });
    expect(JSON.parse(lines[1]!).stage).toBe("write");
  });

  test("reports a write failure without throwing", async () => {
    const stderr: string[] = [];

    await expect(recordGenerationPerformance(performanceRecord(), {
      directory: await mkdtemp(join(tmpdir(), "doxa-perf-log-fail-"))
        .then((directory) => {
          temporaryDirectories.push(directory);
          return directory;
        }),
      appendLine: async () => {
        throw new Error("disk unavailable");
      },
      writeStdout: () => undefined,
      writeStderr: (line) => stderr.push(line),
    })).resolves.toBeUndefined();

    expect(JSON.parse(stderr[0]!)).toMatchObject({
      eventType: "generation_performance_log_failed",
      error: "disk unavailable",
    });
  });

  test("keeps an unsafe job id out of the log path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doxa-perf-log-id-"));
    temporaryDirectories.push(directory);
    const written: string[] = [];

    await recordGenerationPerformance(
      { ...performanceRecord(), jobId: "../../escape" },
      {
        directory,
        appendLine: async (filePath) => {
          written.push(filePath);
        },
        writeStdout: () => undefined,
      },
    );

    expect(written).toEqual([join(directory, "unknown-job.jsonl")]);
  });

  test("prefers the configured log directory over the repository default", () => {
    expect(resolveGenerationPerformanceLogDirectory({
      DOXA_PERFORMANCE_LOG_DIR: "/var/log/doxa",
    })).toBe("/var/log/doxa");
    expect(resolveGenerationPerformanceLogDirectory({}))
      .toMatch(/\.artifacts\/generation-performance-logs$/);
  });
});

function performanceRecord(): GenerationPerformanceRecord {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    stageExecutionId: "22222222-2222-4222-8222-222222222222",
    recordedAt: "2026-07-30T12:00:00.000Z",
    summary: {
      stage: "analysis",
      wallMs: 200,
      snapshotMs: 40,
      modelMs: 100,
      modelCalls: 2,
      toolMs: 30,
      toolCalls: 1,
      validationMs: 20,
      validationCalls: 1,
      busyMs: 120,
      peakConcurrentModelSpans: 2,
      peakConcurrentToolSpans: 1,
      peakConcurrentValidationSpans: 1,
      evidenceFirstPages: 3,
      agenticFallbackPages: 1,
      unattributedMs: 40,
      slowestModelCallMs: 80,
      byOperation: { analysis: { calls: 2, ms: 100 } },
    },
  };
}
