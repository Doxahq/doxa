import { afterEach, describe, expect, test, vi } from "vitest";

import { GenerationNonRetryableError } from "../src/generation-errors";
import { StepCallError, withStepCallDeadline } from "../src/step-call-deadline";

const input = { call: "analysis checkpoint read", jobId: "job-1" };

describe("step call deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("returns the value of a call that answers in time", async () => {
    await expect(withStepCallDeadline(input, async () => "analysis")).resolves.toBe("analysis");
  });

  test("names a call that does not answer in time", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending = withStepCallDeadline({ ...input, timeoutMs: 1_000 }, () => new Promise(() => undefined));
    const outcome = expect(pending).rejects.toMatchObject({
      name: "StepCallError",
      call: "analysis checkpoint read",
      timedOut: true,
      message: "Analysis checkpoint read did not finish within 1 seconds.",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      eventType: "generation_step_call_failed",
      jobId: "job-1",
      call: "analysis checkpoint read",
      timedOut: true,
    });
  });

  test("names a bare runtime error and keeps it as the cause", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hidden = new Error("internal error; reference = abc123");

    const failure = await withStepCallDeadline(input, async () => {
      throw hidden;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepCallError);
    expect(failure).toMatchObject({
      message: "Analysis checkpoint read failed: internal error; reference = abc123",
      timedOut: false,
      cause: hidden,
    });
  });

  test("passes a typed error through unchanged, so a stop stays a stop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stop = new GenerationNonRetryableError("Generation job is no longer active.");

    await expect(withStepCallDeadline(input, async () => {
      throw stop;
    })).rejects.toBe(stop);
  });

  test("ignores a call that fails after its deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let failLate: (error: Error) => void = () => undefined;
    const pending = withStepCallDeadline({ ...input, timeoutMs: 1_000 }, () =>
      new Promise<never>((_resolve, reject) => {
        failLate = reject;
      }),
    );
    const outcome = expect(pending).rejects.toBeInstanceOf(StepCallError);

    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    failLate(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });
});
