import { afterEach, describe, expect, test, vi } from "vitest";
import { cancelGenerationJob } from "../../src/services/generation-cancellation";

describe("generation cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("marks an active job cancelled before destroying its container", async () => {
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
    );

    expect(order).toEqual(["cancelled", "destroyed"]);
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
});
