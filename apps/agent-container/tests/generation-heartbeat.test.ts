import { afterEach, describe, expect, test, vi } from "vitest";
import { startGenerationHeartbeat } from "../src/generation-heartbeat";

describe("generation stream heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("emits typed liveness records periodically until stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const records: unknown[] = [];
    const stop = startGenerationHeartbeat((record) => records.push(record));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(records).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(records).toEqual([{ kind: "heartbeat", elapsedMs: 10_000 }]);

    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(records).toHaveLength(1);
  });
});
