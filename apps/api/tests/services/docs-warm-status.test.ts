import { afterEach, describe, expect, test, vi } from "vitest";
import { DocsWarmStatusService } from "../../src/services/docs-warm-status";

afterEach(() => vi.useRealTimers());

describe("DocsWarmStatusService", () => {
  test("answers null when the dispatcher stalls", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new DocsWarmStatusService({
      siteIdForProject: async () => "site-1",
      binding: { getWarmStatus: () => new Promise(() => {}) },
      timeoutMs: 500,
    });

    const pending = service.forProject("project-1");
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toBeNull();
  });
});
