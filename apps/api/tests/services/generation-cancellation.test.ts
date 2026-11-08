import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CANCELLED_PREVIEW_CHECK,
  cancelGenerationJob,
  finishGenerationCancellation,
  SUPERSEDED_PREVIEW_CHECK,
} from "../../src/services/generation-cancellation";

/** A production job: no pull request check to close. */
const noPreviewCheck = { cancel: vi.fn(async () => false) };

describe("generation cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("marks an active job cancelled, closes its check, then destroys its container", async () => {
    const order: string[] = [];
    const jobs = {
      markCancelled: vi.fn(async () => {
        order.push("cancelled");
        return true;
      }),
      addEvent: vi.fn(async () => undefined),
    };
    const fetch = vi.fn(async () => {
      order.push("destroyed");
      return Response.json({ ok: true });
    });

    const result = await cancelGenerationJob(
      { AGENT_CONTAINER: { fetch } } as never,
      jobs,
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "Cancelled by user.",
        eventType: "user_cancel_requested",
        data: { requestedByUserId: "user-1" },
      },
      {
        cancel: vi.fn(async () => {
          order.push("check");
          return true;
        }),
      },
    );

    expect(order).toEqual(["cancelled", "check", "destroyed"]);
    expect(result).toEqual({
      transitioned: true,
      containerDestroyRequested: true,
    });
    expect(jobs.addEvent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "container_destroy_requested",
      "Agent container destroy requested.",
      { ok: true },
    );
  });

  test("stores the check text with the cancel, for a check that is created meanwhile", async () => {
    const jobs = {
      markCancelled: vi.fn(async () => true),
      addEvent: vi.fn(async () => undefined),
    };
    const stopped = {
      title: "Documentation preview stopped",
      summary: "The pull request was closed, so Doxa stopped this preview.",
    };

    await cancelGenerationJob(
      { AGENT_CONTAINER: { fetch: vi.fn(async () => Response.json({ ok: true })) } } as never,
      jobs,
      {
        jobId: "job-1",
        message: "The pull request was closed.",
        eventType: "doxabot_change_ended",
        data: { reason: "closed" },
        check: stopped,
      },
      { cancel: vi.fn(async () => false) },
    );

    expect(jobs.markCancelled).toHaveBeenCalledWith(
      "job-1",
      "The pull request was closed.",
      "doxabot_change_ended",
      { reason: "closed" },
      stopped,
    );
  });

  test("finishes a cancel that an admission committed: closes the check, then stops the container", async () => {
    const order: string[] = [];
    const jobs = { addEvent: vi.fn(async () => undefined) };
    const fetch = vi.fn(async () => {
      order.push("destroyed");
      return Response.json({ ok: true });
    });
    const cancel = vi.fn(async () => {
      order.push("check");
      return true;
    });

    await expect(
      finishGenerationCancellation(
        { AGENT_CONTAINER: { fetch } } as never,
        jobs,
        { jobId: "job-1", message: "Superseded by a newer pull request head.", check: SUPERSEDED_PREVIEW_CHECK },
        { cancel },
      ),
    ).resolves.toBe(true);

    expect(order).toEqual(["check", "destroyed"]);
    expect(cancel).toHaveBeenCalledWith("job-1", SUPERSEDED_PREVIEW_CHECK);
  });

  test("does not destroy a container when the job is already terminal", async () => {
    const jobs = {
      markCancelled: vi.fn(async () => false),
      addEvent: vi.fn(async () => undefined),
    };
    const fetch = vi.fn();

    await expect(
      cancelGenerationJob(
        { AGENT_CONTAINER: { fetch } } as never,
        jobs,
        { jobId: "job-1", message: "Cancelled by user." },
        noPreviewCheck,
      ),
    ).resolves.toEqual({
      transitioned: false,
      containerDestroyRequested: false,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(jobs.addEvent).not.toHaveBeenCalled();
  });

  test("keeps the transition successful when the destroy attempt throws", async () => {
    const jobs = {
      markCancelled: vi.fn(async () => true),
      addEvent: vi.fn(async () => {
        throw new Error("Event log unreachable.");
      }),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      cancelGenerationJob(
        {} as never,
        jobs,
        { jobId: "job-1", message: "Cancelled by user." },
        noPreviewCheck,
      ),
    ).resolves.toEqual({
      transitioned: true,
      containerDestroyRequested: false,
    });

    expect(consoleError).toHaveBeenCalledWith(
      "Container destroy attempt failed.",
      { jobId: "job-1", message: "Event log unreachable." },
    );
    consoleError.mockRestore();
  });

  test("keeps the transition successful when container destruction is unavailable", async () => {
    const jobs = {
      markCancelled: vi.fn(async () => true),
      addEvent: vi.fn(async () => undefined),
    };

    await expect(
      cancelGenerationJob(
        {} as never,
        jobs,
        { jobId: "job-1", message: "Cancelled by user." },
        noPreviewCheck,
      ),
    ).resolves.toEqual({
      transitioned: true,
      containerDestroyRequested: false,
    });

    expect(jobs.addEvent).toHaveBeenCalledWith(
      "job-1",
      "container_destroy_unavailable",
      "Agent container destroy could not be requested from this runtime.",
      { ok: false },
    );
  });

  test("uses the local agent URL when its service binding is unavailable", async () => {
    const jobs = {
      markCancelled: vi.fn(async () => true),
      addEvent: vi.fn(async () => undefined),
    };
    const localFetch = vi.fn(async () => Response.json({ ok: true, stopped: true }));
    vi.stubGlobal("fetch", localFetch);

    await expect(
      cancelGenerationJob(
        {
          AGENT_CONTAINER: {
            fetch: vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })),
          },
          AGENT_CONTAINER_URL: "http://localhost:8789/",
        } as never,
        jobs,
        { jobId: "11111111-1111-4111-8111-111111111111", message: "Cancelled by user." },
        noPreviewCheck,
      ),
    ).resolves.toEqual({
      transitioned: true,
      containerDestroyRequested: true,
    });

    expect(localFetch).toHaveBeenCalledWith(
      "http://localhost:8789/admin/containers/11111111-1111-4111-8111-111111111111/destroy",
      expect.objectContaining({ method: "POST" }),
    );
    expect(jobs.addEvent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "container_destroy_requested",
      "Agent container destroy requested.",
      { ok: true },
    );
  });

  test("closes a preview check with the caller's text, or the default text", async () => {
    const jobs = { markCancelled: vi.fn(async () => true), addEvent: vi.fn(async () => undefined) };
    const previewChecks = { cancel: vi.fn(async () => true) };
    const check = { title: "Documentation preview stopped", summary: "The pull request was merged." };

    await cancelGenerationJob({} as never, jobs, { jobId: "job-1", message: "Merged.", check }, previewChecks);
    await cancelGenerationJob({} as never, jobs, { jobId: "job-2", message: "Cancelled by user." }, previewChecks);

    expect(previewChecks.cancel).toHaveBeenNthCalledWith(1, "job-1", check);
    expect(previewChecks.cancel).toHaveBeenNthCalledWith(2, "job-2", CANCELLED_PREVIEW_CHECK);
  });

  test("keeps the cancellation when GitHub refuses the check update, and records why", async () => {
    const jobs = { markCancelled: vi.fn(async () => true), addEvent: vi.fn(async () => undefined) };
    const previewChecks = {
      cancel: vi.fn(async () => {
        throw new Error("GitHub unavailable");
      }),
    };

    await expect(
      cancelGenerationJob({} as never, jobs, { jobId: "job-1", message: "Cancelled by user." }, previewChecks),
    ).resolves.toMatchObject({ transitioned: true });
    expect(jobs.addEvent).toHaveBeenCalledWith(
      "job-1",
      "review_run_update_failed",
      "Doxabot could not mark the pull request check as cancelled.",
      { error: "GitHub unavailable" },
    );
  });

  test("leaves the check alone when the job had already ended", async () => {
    const jobs = { markCancelled: vi.fn(async () => false), addEvent: vi.fn(async () => undefined) };
    const previewChecks = { cancel: vi.fn(async () => true) };

    await cancelGenerationJob({} as never, jobs, { jobId: "job-1", message: "Cancelled by user." }, previewChecks);

    expect(previewChecks.cancel).not.toHaveBeenCalled();
  });
});
