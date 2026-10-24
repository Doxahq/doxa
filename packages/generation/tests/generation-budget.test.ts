import { describe, expect, test } from "vitest";
import {
  assessGenerationFeasibility,
  planPageBatches,
  writingStageTimeoutMs,
} from "../src/generation-budget";

describe("generation workload budgets", () => {
  test("plans deterministic page batches at the configured concurrency", () => {
    const pageIds = Array.from({ length: 78 }, (_, index) => `page-${index + 1}`);

    const batches = planPageBatches(pageIds, 6);

    expect(batches).toHaveLength(13);
    expect(batches[0]).toEqual(["page-1", "page-2", "page-3", "page-4", "page-5", "page-6"]);
    expect(batches.at(-1)).toEqual(["page-73", "page-74", "page-75", "page-76", "page-77", "page-78"]);
    expect(batches.flat()).toEqual(pageIds);
  });

  test("rejects invalid concurrency rather than producing an unbounded loop", () => {
    expect(() => planPageBatches(["page-1"], 0)).toThrow("Pages per batch must be a positive integer.");
    expect(() => planPageBatches(["page-1"], 1.5)).toThrow("Pages per batch must be a positive integer.");
  });

  test("sizes the writing stage from the number of sequential batches", () => {
    expect(writingStageTimeoutMs({
      pageCount: 78,
      pagesPerBatch: 6,
      pageBatchTimeoutMs: 10 * 60_000,
    })).toBe(130 * 60_000);
  });

  test("sizes the writing stage from parallel batch waves", () => {
    expect(writingStageTimeoutMs({
      pageCount: 78,
      pagesPerBatch: 6,
      pageBatchTimeoutMs: 10 * 60_000,
      batchParallelism: 2,
    })).toBe(70 * 60_000);
  });

  test("adds the waves of large template groups to the waves of model groups", () => {
    expect(writingStageTimeoutMs({
      pageCount: 48,
      pagesPerBatch: 24,
      pageBatchTimeoutMs: 30 * 60_000,
      batchParallelism: 2,
      templatePages: {
        pageCount: 3_762,
        pagesPerBatch: 500,
        pageBatchTimeoutMs: 10 * 60_000,
      },
    })).toBe(30 * 60_000 + 4 * 10 * 60_000);
  });

  test("needs no write time when a kind has no pages", () => {
    expect(writingStageTimeoutMs({
      pageCount: 0,
      pagesPerBatch: 24,
      pageBatchTimeoutMs: 30 * 60_000,
      templatePages: {
        pageCount: 120,
        pagesPerBatch: 500,
        pageBatchTimeoutMs: 10 * 60_000,
      },
    })).toBe(10 * 60_000);
  });

  test("rejects an invalid template group size", () => {
    expect(() => writingStageTimeoutMs({
      pageCount: 12,
      pagesPerBatch: 6,
      pageBatchTimeoutMs: 10 * 60_000,
      templatePages: { pageCount: 12, pagesPerBatch: 0, pageBatchTimeoutMs: 60_000 },
    })).toThrow("Pages per batch must be a positive integer.");
  });

  test.each([0, -1, 1.5])(
    "rejects invalid batch parallelism %s",
    (batchParallelism) => {
      expect(() => writingStageTimeoutMs({
        pageCount: 12,
        pagesPerBatch: 6,
        pageBatchTimeoutMs: 10 * 60_000,
        batchParallelism,
      })).toThrow("Batch parallelism must be a positive integer.");
    },
  );

  test("fails fast when the planned writing work cannot fit the overall deadline", () => {
    expect(assessGenerationFeasibility({
      elapsedMs: 464_000,
      overallTimeoutMs: 12 * 60_000,
      pageCount: 78,
      pagesPerBatch: 6,
      pageBatchTimeoutMs: 10 * 60_000,
      batchParallelism: 2,
      finalizationTimeoutMs: 5 * 60_000,
    })).toEqual({
      feasible: false,
      batchCount: 13,
      remainingMs: 256_000,
      requiredMs: 4_500_000,
    });
  });

  test("counts template batches in the feasibility of a large API", () => {
    expect(assessGenerationFeasibility({
      elapsedMs: 30 * 60_000,
      overallTimeoutMs: 3 * 60 * 60_000,
      pageCount: 30,
      pagesPerBatch: 24,
      pageBatchTimeoutMs: 30 * 60_000,
      batchParallelism: 2,
      templatePages: {
        pageCount: 3_762,
        pagesPerBatch: 500,
        pageBatchTimeoutMs: 10 * 60_000,
      },
      finalizationTimeoutMs: 10 * 60_000,
    })).toEqual({
      feasible: true,
      batchCount: 10,
      remainingMs: 150 * 60_000,
      requiredMs: 80 * 60_000,
    });
  });
});
