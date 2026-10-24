import { afterEach, describe, expect, test, vi } from "vitest";
import { createStageTimings } from "../src/stage-timings";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stage timing aggregation", () => {
  test("summarizes spans and clamps unattributed time", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(100);
    const timings = createStageTimings("write");

    timings.markSnapshot(15);
    timings.markWriterExploration("evidence_first");
    timings.markWriterExploration("agentic_fallback");
    timings.onSpan({
      kind: "model",
      name: "page_write",
      startedAt: 110,
      endedAt: 140,
      durationMs: 30,
      ok: true,
      context: { operation: "page_write", pageId: "overview" },
    });
    timings.onSpan({
      kind: "tool",
      name: "Read",
      startedAt: 140,
      endedAt: 160,
      durationMs: 20,
      ok: true,
    });
    timings.onSpan({
      kind: "validation",
      name: "mdx_compile",
      startedAt: 160,
      endedAt: 170,
      durationMs: 10,
      ok: true,
    });
    now.mockReturnValueOnce(200);

    expect(timings.summarize()).toEqual({
      stage: "write",
      wallMs: 100,
      snapshotMs: 15,
      modelMs: 30,
      modelCalls: 1,
      toolMs: 20,
      toolCalls: 1,
      validationMs: 10,
      validationCalls: 1,
      busyMs: 60,
      peakConcurrentModelSpans: 1,
      peakConcurrentToolSpans: 1,
      peakConcurrentValidationSpans: 1,
      evidenceFirstPages: 1,
      agenticFallbackPages: 1,
      unattributedMs: 25,
      slowestModelCallMs: 30,
      byOperation: {
        page_write: { calls: 1, ms: 30 },
        Read: { calls: 1, ms: 20 },
        mdx_compile: { calls: 1, ms: 10 },
      },
    });
  });

  test("never reports negative unattributed time", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(100);
    const timings = createStageTimings("analysis");
    timings.onSpan({
      kind: "model",
      name: "analysis",
      startedAt: 100,
      endedAt: 150,
      durationMs: 50,
      ok: true,
      context: { operation: "analysis" },
    });
    now.mockReturnValueOnce(120);

    expect(timings.summarize().unattributedMs).toBe(0);
  });

  test("merges overlapping spans and reports peak concurrency", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000);
    const timings = createStageTimings("write");

    timings.onSpan({
      kind: "model",
      name: "page_write",
      startedAt: 1_010,
      endedAt: 1_110,
      durationMs: 100,
      ok: true,
      context: { operation: "page_write", pageId: "overview" },
    });
    timings.onSpan({
      kind: "model",
      name: "page_write",
      startedAt: 1_010,
      endedAt: 1_110,
      durationMs: 100,
      ok: true,
      context: { operation: "page_write", pageId: "quickstart" },
    });
    now.mockReturnValueOnce(1_150);

    const summary = timings.summarize();
    expect(summary.modelMs).toBe(200);
    expect(summary.busyMs).toBe(100);
    expect(summary.peakConcurrentModelSpans).toBe(2);
    expect(summary.peakConcurrentToolSpans).toBe(0);
    expect(summary.peakConcurrentValidationSpans).toBe(0);
    expect(summary.unattributedMs).toBe(50);
  });

  test("does not count nested tool and validation spans as model concurrency", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000);
    const timings = createStageTimings("write");

    timings.onSpan({
      kind: "tool",
      name: "validate_page",
      startedAt: 1_010,
      endedAt: 1_110,
      durationMs: 100,
      ok: true,
    });
    timings.onSpan({
      kind: "validation",
      name: "mdx_compile",
      startedAt: 1_020,
      endedAt: 1_100,
      durationMs: 80,
      ok: true,
    });
    now.mockReturnValueOnce(1_150);

    expect(timings.summarize()).toMatchObject({
      busyMs: 100,
      peakConcurrentModelSpans: 0,
      peakConcurrentToolSpans: 1,
      peakConcurrentValidationSpans: 1,
    });
  });
});
