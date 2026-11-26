import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/env";

/**
 * How the worker's job-state calls close a preview's pull request check.
 * Found 2026-11-25 on Doxahq/doxa pull request 1: a preview that failed
 * with `generation_context_unavailable` left its GitHub check "queued" for
 * hours, because failing the job never closed the check.
 */

const jobs = {
  markFailed: vi.fn(async (_jobId: string, _message: string) => true),
  markCancelled: vi.fn(async (..._args: unknown[]) => true),
  addEvent: vi.fn(async (..._args: unknown[]) => undefined),
};
const checks = {
  finish: vi.fn(async (..._args: unknown[]) => true),
  cancel: vi.fn(async (..._args: unknown[]) => true),
};
const notifier = { finished: vi.fn(async () => undefined) };
const metering = { settle: vi.fn(async () => undefined) };

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("../../src/repositories/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/repositories/jobs")>()),
  JobsRepository: vi.fn(() => jobs),
}));
vi.mock("../../src/services/doxabot/review-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/doxabot/review-runs")>()),
  ReviewRunsService: { fromEnv: vi.fn(() => checks) },
}));
vi.mock("../../src/services/email/notifications", () => ({
  generationNotifierFromEnv: vi.fn(() => notifier),
}));
vi.mock("../../src/services/billing/generation-metering-env", () => ({
  generationMeteringFromEnv: vi.fn(() => metering),
}));
vi.mock("../../src/services/generation-analytics", () => ({
  reportGenerationFinishedInBackground: vi.fn(),
}));

const { InternalApi } = await import("../../src/services/internal-api");
const { RETRY_PREVIEW_ACTION, timedOutPreviewEnding } = await import("../../src/services/doxabot/review-runs");

const jobId = "11111111-1111-4111-8111-111111111111";

const executionContext: ExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

/**
 * Every collaborator that reads the environment is mocked above, so no
 * binding is read. `Env` holds R2 and queue bindings that a unit test
 * cannot build, hence the one cast (as in the other API tests).
 */
const env = {} as Env;

function api() {
  return new InternalApi(executionContext, env);
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs.markFailed.mockResolvedValue(true);
  jobs.markCancelled.mockResolvedValue(true);
  checks.finish.mockResolvedValue(true);
});

describe("closing a preview's check when the worker fails its job", () => {
  test("a failed job closes its check as failure with the reason and a retry", async () => {
    await api().markJobFailed(jobId, "Doxa could not load the settings for this generation. Try again later.");

    expect(jobs.markFailed).toHaveBeenCalledWith(jobId, "Doxa could not load the settings for this generation. Try again later.");
    expect(metering.settle).toHaveBeenCalledWith(jobId, "failed");
    expect(checks.finish).toHaveBeenCalledWith(jobId, "failure", {
      title: "Documentation preview failed",
      summary: "Doxa could not load the settings for this generation. Try again later.",
      retryable: true,
    });
  });

  test("a failure that the worker names as needing a person closes without a retry", async () => {
    await api().markJobFailed(jobId, "Merge conflict.", {
      conclusion: "action_required",
      title: "Documentation preview needs a clean merge",
      summary: "Resolve the merge conflict.",
    });

    expect(checks.finish).toHaveBeenCalledWith(jobId, "action_required", {
      title: "Documentation preview needs a clean merge",
      summary: "Resolve the merge conflict.",
      retryable: false,
    });
  });

  test("refuses a check text that breaks the contract, before the job changes", async () => {
    await expect(
      api().markJobFailed(jobId, "Boom.", { conclusion: "action_required", title: "", summary: "x" }),
    ).rejects.toThrow();
    expect(jobs.markFailed).not.toHaveBeenCalled();
  });

  test("a job that already ended keeps its check", async () => {
    jobs.markFailed.mockResolvedValue(false);

    await api().markJobFailed(jobId, "Boom.");

    expect(checks.finish).not.toHaveBeenCalled();
    expect(metering.settle).not.toHaveBeenCalled();
  });

  test("a GitHub failure is recorded on the job and never fails the call", async () => {
    checks.finish.mockRejectedValue(new Error("GitHub check run update failed (502)."));

    await expect(api().markJobFailed(jobId, "Boom.")).resolves.toBeUndefined();

    expect(jobs.addEvent).toHaveBeenCalledWith(
      jobId,
      "review_run_update_failed",
      "Doxabot could not complete the pull request check.",
      { error: "GitHub check run update failed (502)." },
    );
  });
});

describe("closing a preview's check when the watchdog ends a stale job", () => {
  test("a queued job is cancelled, and its check reads timed out with a retry", async () => {
    await api().markJobTimedOut(jobId, "queued", "Queued generation cancelled by watchdog after waiting too long.");

    const ending = timedOutPreviewEnding("queued");
    expect(jobs.markFailed).not.toHaveBeenCalled();
    // The cancel stores the check text, for a check that is created during the cancel.
    expect(jobs.markCancelled).toHaveBeenCalledWith(
      jobId,
      "Queued generation cancelled by watchdog after waiting too long.",
      "generation_cancelled",
      undefined,
      ending,
    );
    expect(metering.settle).toHaveBeenCalledWith(jobId, "cancelled");
    expect(checks.cancel).toHaveBeenCalledWith(jobId, ending);
    expect(ending.retryable).toBe(true);
  });

  test("a running job fails, and its check reads timed out with a retry", async () => {
    await api().markJobTimedOut(jobId, "running", "Running generation marked failed by watchdog after timing out.");

    expect(jobs.markCancelled).not.toHaveBeenCalled();
    expect(jobs.markFailed).toHaveBeenCalledWith(jobId, "Running generation marked failed by watchdog after timing out.");
    expect(checks.finish).toHaveBeenCalledWith(jobId, "failure", timedOutPreviewEnding("running"));
  });

  test("refuses a status that is not stale-able", async () => {
    await expect(
      // @ts-expect-error The worker sends this over RPC; a wrong value must be refused.
      api().markJobTimedOut(jobId, "succeeded", "x"),
    ).rejects.toThrow();
    expect(jobs.markFailed).not.toHaveBeenCalled();
    expect(jobs.markCancelled).not.toHaveBeenCalled();
  });

  test("the retry button is the one GitHub sends back as retry_preview", () => {
    expect(RETRY_PREVIEW_ACTION.identifier).toBe("retry_preview");
  });
});
