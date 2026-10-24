import { describe, expect, test, vi } from "vitest";
import {
  dispatchWorkflowBatches,
  resolveWriteGroupSize,
  finalizeRuntimeNavigation,
  GenerationNonRetryableError,
  GenerationWorkflowRunner,
  isCrossModelPageCacheEnabled,
  isPageCacheEnabled,
  isPlanStageEnabled,
  logPageCacheBatchSummary,
  resolveWriteBatchParallelism,
  type GenerationWorkflowStep,
} from "../src/generation-workflow-runtime";
import { isRunStoppingError } from "../src/generation-page-failures";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function recordingStep(
  events: string[],
  onStart: (name: string) => void = () => undefined,
): GenerationWorkflowStep {
  return {
    do: async <T>(
      name: string,
      _config: unknown,
      callback: () => Promise<T>,
    ): Promise<T> => {
      events.push(`start:${name}`);
      onStart(name);
      try {
        return await callback();
      } finally {
        events.push(`finish:${name}`);
      }
    },
  };
}

describe("generation workflow runtime", () => {
  test.each([
    [undefined, true],
    ["", true],
    ["1", true],
    ["false", true],
    ["0", false],
    [" 0 ", false],
  ])(
    "resolves combined plan-stage setting %j to %j",
    (configured, expected) => {
      expect(isPlanStageEnabled(configured)).toBe(expected);
    },
  );

  test.each([
    [undefined, true],
    ["", true],
    ["1", true],
    ["false", true],
    ["0", false],
    [" 0 ", false],
  ])(
    "resolves page-cache setting %j to %j",
    (configured, expected) => {
      expect(isPageCacheEnabled(configured)).toBe(expected);
    },
  );

  test.each([
    ["preview", undefined, false],
    ["preview", "0", false],
    ["preview", "false", false],
    ["preview", "1", true],
    ["preview", " true ", true],
    ["preview", "yes", true],
    ["preview", "on", true],
    ["production", "1", false],
  ] as const)(
    "resolves %s cross-model cache setting %j to %j",
    (publicationMode, configured, expected) => {
      expect(isCrossModelPageCacheEnabled({
        publicationMode,
        value: configured,
      })).toBe(expected);
    },
  );

  test("logs page-cache batch counts to stdout instead of the job event stream", () => {
    const lines: string[] = [];

    logPageCacheBatchSummary({
      jobId: "11111111-1111-4111-8111-111111111111",
      pageCount: 3,
      result: {
        keys: ["page-1", "page-2", "page-3"],
        failedPages: [],
        exactHits: 1,
        crossModelHits: 1,
        generated: 1,
      },
      writeStdout: (line) => lines.push(line),
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      service: "doxa-agent-worker",
      eventType: "generation_page_cache_summary",
      jobId: "11111111-1111-4111-8111-111111111111",
      pageCount: 3,
      exactHits: 1,
      crossModelHits: 1,
      generated: 1,
      failed: 0,
    });
  });

  test.each([
    [undefined, 24],
    ["", 24],
    ["0", 24],
    ["12", 12],
    ["12.7", 12],
    ["500", 64],
  ])("resolves write group size %j to %i", (configured, expected) => {
    expect(resolveWriteGroupSize(configured)).toBe(expected);
  });

  test.each([
    [undefined, 2],
    ["", 2],
    ["not-a-number", 2],
    ["0", 1],
    ["-3", 1],
    ["2", 2],
    ["3.8", 3],
    ["9", 4],
  ])(
    "resolves write batch parallelism %j to %i",
    (configured, expected) => {
      expect(resolveWriteBatchParallelism(configured)).toBe(expected);
    },
  );

  test.each([
    {
      path: "default",
      name: (index: number, total: number) =>
        `write page batch ${index + 1} of ${total}`,
    },
    {
      path: "revision-aware",
      name: (index: number, total: number) =>
        `write affected production page batch ${index + 1} of ${total}`,
    },
  ])(
    "dispatches $path write batches in parallel and returns batch-order results",
    async ({ name }) => {
      const events: string[] = [];
      const responses = Array.from(
        { length: 4 },
        () => deferred<{ keys: string[] }>(),
      );
      const thirdStarted = deferred<void>();
      const dispatched = dispatchWorkflowBatches({
        batches: [["page-1"], ["page-2"], ["page-3"], ["page-4"]],
        parallelism: 2,
        step: recordingStep(events, (startedName) => {
          if (startedName === name(2, 4)) thirdStarted.resolve();
        }),
        stepName: name,
        stepConfig: () => ({}),
        isRunStopping: isRunStoppingError,
        runBatch: async (_batch, index) => responses[index]?.promise ?? {
          keys: [],
        },
      });

      await Promise.resolve();
      expect(events.slice(0, 2)).toEqual([
        `start:${name(0, 4)}`,
        `start:${name(1, 4)}`,
      ]);

      responses[1]?.resolve({ keys: ["key-2"] });
      await thirdStarted.promise;
      expect(events).toContain(`start:${name(2, 4)}`);
      expect(events).not.toContain(`finish:${name(0, 4)}`);

      responses[2]?.resolve({ keys: ["key-3"] });
      await Promise.resolve();
      await Promise.resolve();
      responses[3]?.resolve({ keys: ["key-4"] });
      responses[0]?.resolve({ keys: ["key-1"] });

      await expect(dispatched).resolves.toEqual([
        { status: "fulfilled", value: { keys: ["key-1"] } },
        { status: "fulfilled", value: { keys: ["key-2"] } },
        { status: "fulfilled", value: { keys: ["key-3"] } },
        { status: "fulfilled", value: { keys: ["key-4"] } },
      ]);
    },
  );

  test("a failed batch settles alone while the other batches still run", async () => {
    const inFlight = deferred<string>();
    const started: number[] = [];
    const dispatched = dispatchWorkflowBatches({
      batches: [0, 1, 2, 3],
      parallelism: 2,
      step: recordingStep([]),
      stepName: (index) => `batch ${index + 1}`,
      stepConfig: () => ({}),
      isRunStopping: isRunStoppingError,
      runBatch: async (_batch, index) => {
        started.push(index);
        if (index === 0) {
          throw new GenerationNonRetryableError("batch failed");
        }
        return index === 1 ? inFlight.promise : `batch ${index + 1}`;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    inFlight.resolve("finished");
    const results = await dispatched;

    expect(started).toEqual([0, 1, 2, 3]);
    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results.slice(1)).toEqual([
      { status: "fulfilled", value: "finished" },
      { status: "fulfilled", value: "batch 3" },
      { status: "fulfilled", value: "batch 4" },
    ]);
  });

  test("a cancellation failure prevents remaining batches from starting", async () => {
    const sibling = deferred<string>();
    const started: number[] = [];
    const dispatched = dispatchWorkflowBatches({
      batches: [0, 1, 2, 3],
      parallelism: 2,
      step: recordingStep([]),
      stepName: (index) => `batch ${index + 1}`,
      stepConfig: () => ({}),
      isRunStopping: isRunStoppingError,
      runBatch: async (_batch, index) => {
        started.push(index);
        if (index === 0) {
          throw new GenerationNonRetryableError(
            "Generation job is no longer active.",
          );
        }
        return sibling.promise;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    sibling.resolve("finished");
    await expect(dispatched).rejects.toThrow(
      "Generation job is no longer active.",
    );
    expect(started).toEqual([0, 1]);
  });

  test("finalizes grouped navigation against assembled page checkpoints", () => {
    const navigation = finalizeRuntimeNavigation(
      {
        sections: [
          {
            slug: "default",
            items: ["default/overview.md", "default/stale.md"],
            groups: [
              {
                heading: "Start Here",
                items: ["default/overview.md"],
              },
              {
                heading: "Removed",
                items: ["default/stale.md"],
              },
            ],
          },
          {
            slug: "empty",
            items: ["empty/stale.md"],
          },
        ],
        icons: {
          "default/overview.md": "compass",
          "default/stale.md": "file",
        },
        navTitles: {
          "default/overview.md": "Overview",
          "default/stale.md": "Stale",
        },
        navBadges: {
          "default/stale.md": "API",
        },
        sectionMetadata: {
          default: { label: "Documentation" },
          empty: { label: "Empty" },
        },
      },
      [{ navigationPath: "default/overview.md" }],
    );

    expect(navigation).toEqual({
      sections: [
        {
          slug: "default",
          items: ["default/overview.md"],
          groups: [
            {
              heading: "Start Here",
              items: ["default/overview.md"],
            },
          ],
        },
      ],
      icons: { "default/overview.md": "compass" },
      navTitles: { "default/overview.md": "Overview" },
      navBadges: {},
      sectionMetadata: {
        default: { label: "Documentation" },
      },
    });
  });

  test("rejects an incompatible database before resolving or starting generation", async () => {
    const getGenerationExecutionContext = vi.fn(async () => null);
    const markJobFailed = vi.fn(async () => undefined);
    const addJobEvent = vi.fn(async () => undefined);
    const runner = new GenerationWorkflowRunner({
      API: {
        getGenerationDatabaseCompatibility: async () => ({
          ready: false,
          missingColumns: ["writer_attempt"],
        }),
        getGenerationExecutionContext,
        markJobFailed,
        addJobEvent,
      },
    } as never);

    await expect(
      runner.run(
        {
          payload: {
            jobId: "11111111-1111-4111-8111-111111111111",
            projectId: "22222222-2222-4222-8222-222222222222",
            userId: "33333333-3333-4333-8333-333333333333",
          },
          timestamp: new Date(),
        },
        {
          do: async <T>(
            _name: string,
            _config: unknown,
            callback: () => Promise<T>,
          ) => callback(),
        },
      ),
    ).rejects.toThrow(
      "Generation database schema is incompatible; missing columns: writer_attempt.",
    );

    expect(getGenerationExecutionContext).not.toHaveBeenCalled();
    expect(markJobFailed).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Generation database schema is incompatible; missing columns: writer_attempt.",
    );
    expect(addJobEvent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        type: "database_schema_incompatible",
      }),
    );
  });

  test("runs the production workflow from a Node-importable adapter", async () => {
    const calls: string[] = [];
    const runner = new GenerationWorkflowRunner({
      API: {
        getGenerationExecutionContext: async () => null,
        getGenerationDatabaseCompatibility: async () => ({
          ready: true,
          missingColumns: [],
        }),
        getGenerationControl: async () => ({ status: "paused" as const }),
        markJobCancelled: async () => {
          calls.push("cancelled");
        },
        isJobActive: async () => false,
        getGenerationUsageSummary: async () => ({
          callCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          costUsd: null,
          promptCostUsd: null,
          completionCostUsd: null,
          upstreamCostUsd: null,
          costComplete: false,
          byModel: [],
        }),
      },
      DOCS_BUCKET: {
        list: async () => ({ objects: [], truncated: false }),
      },
    } as never);

    await expect(
      runner.run(
        {
          payload: {
            jobId: "11111111-1111-4111-8111-111111111111",
            projectId: "22222222-2222-4222-8222-222222222222",
            userId: "33333333-3333-4333-8333-333333333333",
          },
          timestamp: new Date(),
        },
        {
          do: async <T>(
            _name: string,
            _config: unknown,
            callback: () => Promise<T>,
          ) => callback(),
        },
      ),
    ).rejects.toThrow("Generation is paused.");

    expect(calls).toEqual(["cancelled"]);
  });
});
