import { describe, expect, test, vi } from "vitest";

import { NO_STEP_RETRIES, runBestEffortStep, settleWritePhase } from "../src/best-effort-step";
import { GenerationNonRetryableError } from "../src/generation-errors";

const config = { retries: NO_STEP_RETRIES, timeout: 60_000 };

describe("a best-effort step", () => {
  test("runs once with no retries and returns its result", async () => {
    const configs: unknown[] = [];
    const work = vi.fn(async () => ["guide"]);

    const result = await runBestEffortStep({
      step: {
        do: async <T>(_name: string, stepConfig: unknown, callback: () => Promise<T>) => {
          configs.push(stepConfig);
          return callback();
        },
      },
      name: "record instruction catch-up",
      config,
      fallback: [],
      work,
      onError: () => undefined,
    });

    expect(result).toEqual(["guide"]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(configs).toEqual([expect.objectContaining({ retries: expect.objectContaining({ limit: 0 }) })]);
  });

  test("a failed step, a timeout included, gives the fallback and never fails the run", async () => {
    const onError = vi.fn();

    const result = await runBestEffortStep({
      step: { do: async () => { throw new Error("step timed out"); } },
      name: "record page notices",
      config,
      fallback: "fallback",
      work: async () => "result",
      onError,
    });

    expect(result).toBe("fallback");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "step timed out" }));
  });
});

describe("the end of a write phase", () => {
  test("counts catch-up failures before a page failure budget stops the run, and records no notices", async () => {
    const calls: string[] = [];

    await expect(settleWritePhase({
      recordCatchUp: async () => {
        calls.push("ledger");
        return ["guide"];
      },
      checkPageFailureBudget: async () => {
        calls.push("budget");
        throw new GenerationNonRetryableError("4 of 5 pages could not be written");
      },
      recordNotices: async () => {
        calls.push("notices");
      },
    })).rejects.toThrow("4 of 5 pages could not be written");

    expect(calls).toEqual(["ledger", "budget"]);
  });

  test("passes the exhausted pages from the ledger to the notices of a run that goes on", async () => {
    const recordNotices = vi.fn(async () => undefined);

    await expect(settleWritePhase({
      recordCatchUp: async () => ["guide"],
      checkPageFailureBudget: async () => undefined,
      recordNotices,
    })).resolves.toEqual(["guide"]);

    expect(recordNotices).toHaveBeenCalledWith(["guide"]);
  });
});
