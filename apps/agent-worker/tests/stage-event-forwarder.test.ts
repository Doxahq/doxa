import { describe, expect, test, vi } from "vitest";
import {
  forwardGenerationStageEvent,
  forwardGenerationStageFailure,
} from "../src/stage-event-forwarder";

describe("generation stage event forwarding", () => {
  test("does not restart generation when dashboard event persistence fails", async () => {
    const persist = vi.fn().mockRejectedValue(
      new Error("Temporary API failure for secret-token"),
    );
    const log = vi.fn();

    await expect(forwardGenerationStageEvent({
      jobId: "11111111-1111-4111-8111-111111111111",
      stage: "write",
      event: {
        source: "container",
        type: "page_write_completed",
        message: "Page completed.",
      },
      secrets: ["secret-token"],
      persist,
      log,
    })).resolves.toBeUndefined();

    expect(persist).toHaveBeenCalledWith({
      type: "page_write_completed",
      message: "Page completed.",
      source: "container",
      data: undefined,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain(
      '"eventType":"generation_stage_event_delivery_failed"',
    );
    expect(log.mock.calls[0]?.[0]).not.toContain("secret-token");
  });

  test("persists a retryable stage attempt without the failed event type", async () => {
    const persist = vi.fn(async () => undefined);

    await forwardGenerationStageFailure({
      jobId: "11111111-1111-4111-8111-111111111111",
      stage: "plan",
      errorMessage: "Git failed with secret-token",
      retryable: true,
      code: "generation_stage_transport_failed",
      secrets: ["secret-token"],
      persist,
    });

    expect(persist).toHaveBeenCalledWith({
      type: "generation_stage_attempt_retrying",
      message:
        "Plan stage attempt failed and will retry: Git failed with [redacted]",
      source: "worker",
      data: {
        stage: "plan",
        retryable: true,
        code: "generation_stage_transport_failed",
      },
    });
  });

  test("persists a sanitized final stage failure for the generation log", async () => {
    const persist = vi.fn(async () => undefined);

    await forwardGenerationStageFailure({
      jobId: "11111111-1111-4111-8111-111111111111",
      stage: "plan",
      errorMessage: "Git failed with secret-token",
      retryable: false,
      code: "workflow_non_retryable",
      secrets: ["secret-token"],
      persist,
    });

    expect(persist).toHaveBeenCalledWith({
      type: "generation_stage_attempt_failed",
      message: "Plan stage attempt failed: Git failed with [redacted]",
      source: "worker",
      data: {
        stage: "plan",
        retryable: false,
        code: "workflow_non_retryable",
      },
    });
  });

  test("does not replace a stage failure when its log event cannot be persisted", async () => {
    const persist = vi.fn().mockRejectedValue(
      new Error("Temporary API failure for secret-token"),
    );
    const log = vi.fn();

    await expect(forwardGenerationStageFailure({
      jobId: "11111111-1111-4111-8111-111111111111",
      stage: "write",
      errorMessage: "Writer failed.",
      retryable: true,
      code: "generation_stage_transport_failed",
      secrets: ["secret-token"],
      persist,
      log,
    })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain(
      '"eventType":"generation_stage_failure_event_delivery_failed"',
    );
    expect(log.mock.calls[0]?.[0]).not.toContain("secret-token");
  });
});
