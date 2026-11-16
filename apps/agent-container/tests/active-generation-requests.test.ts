import { describe, expect, test } from "vitest";
import { ActiveGenerationRequests } from "../src/active-generation-requests";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("active generation requests", () => {
  test("aborts the active request for the cancelled job", () => {
    const requests = new ActiveGenerationRequests();
    const controller = new AbortController();

    expect(requests.register(JOB_ID, controller)).toBe(true);
    expect(requests.cancel(JOB_ID)).toBe(true);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toEqual(new Error("Generation cancelled by user."));
  });

  test("rejects a generation that arrives immediately after cancellation", () => {
    const requests = new ActiveGenerationRequests();
    const controller = new AbortController();

    expect(requests.cancel(JOB_ID)).toBe(false);
    expect(requests.register(JOB_ID, controller)).toBe(false);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toEqual(new Error("Generation cancelled by user."));
  });

  test("rejects repeated delivery attempts for a cancelled job", () => {
    const requests = new ActiveGenerationRequests();
    const firstController = new AbortController();
    const retryController = new AbortController();

    requests.cancel(JOB_ID);

    expect(requests.register(JOB_ID, firstController)).toBe(false);
    expect(requests.register(JOB_ID, retryController)).toBe(false);
    expect(firstController.signal.aborted).toBe(true);
    expect(retryController.signal.aborted).toBe(true);
  });

  test("aborts every concurrent request registered for one job", () => {
    const requests = new ActiveGenerationRequests();
    const first = new AbortController();
    const second = new AbortController();

    expect(requests.register(JOB_ID, first)).toBe(true);
    expect(requests.register(JOB_ID, second)).toBe(true);
    expect(requests.cancel(JOB_ID)).toBe(true);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  test("unregistering one request leaves its sibling active", () => {
    const requests = new ActiveGenerationRequests();
    const first = new AbortController();
    const second = new AbortController();

    requests.register(JOB_ID, first);
    requests.register(JOB_ID, second);
    requests.unregister(JOB_ID, first);

    expect(requests.cancel(JOB_ID)).toBe(true);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });

  test("a stop aborts the job's requests but accepts its next request (a continued job)", () => {
    const requests = new ActiveGenerationRequests();
    const stopped = new AbortController();
    const continued = new AbortController();

    requests.register(JOB_ID, stopped);
    expect(requests.stop(JOB_ID)).toBe(true);
    expect(stopped.signal.aborted).toBe(true);

    expect(requests.register(JOB_ID, continued)).toBe(true);
    expect(continued.signal.aborted).toBe(false);
  });

  test("keeps the cancellation tombstone after cancelling concurrent requests", () => {
    const requests = new ActiveGenerationRequests();
    const active = new AbortController();
    const late = new AbortController();

    requests.register(JOB_ID, active);
    requests.cancel(JOB_ID);

    expect(requests.register(JOB_ID, late)).toBe(false);
    expect(late.signal.reason).toEqual(
      new Error("Generation cancelled by user."),
    );
  });
});
