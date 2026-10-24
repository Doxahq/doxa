import { describe, expect, test } from "vitest";
import {
  AdaptiveConcurrencyLimiter,
  DEFAULT_WRITER_WIDTH_POLICY,
  writerWidthPolicy,
} from "../src/utils/adaptive-concurrency";

const policy = { start: 2, min: 1, max: 4, increaseAfterSuccesses: 2, decreaseCooldownMs: 1_000 };

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("adaptive concurrency limiter", () => {
  test("never runs more writers than its width", async () => {
    const limiter = new AdaptiveConcurrencyLimiter(policy);
    const first = await limiter.acquire();
    await limiter.acquire();
    let thirdStarted = false;
    const third = limiter.acquire().then((release) => {
      thirdStarted = true;
      return release;
    });

    await flush();
    expect(thirdStarted).toBe(false);
    first();
    await third;
    expect(thirdStarted).toBe(true);
    expect(limiter.active).toBe(2);
  });

  test("grows by one after successes and stops at its ceiling", () => {
    const limiter = new AdaptiveConcurrencyLimiter(policy);
    for (let index = 0; index < 10; index++) limiter.recordSuccess();
    expect(limiter.width).toBe(4);
  });

  test("halves once per burst of throttles and keeps its floor", () => {
    let now = 0;
    const limiter = new AdaptiveConcurrencyLimiter({ ...policy, start: 4 }, () => now);

    limiter.recordThrottle();
    limiter.recordThrottle();
    expect(limiter.width).toBe(2);

    now = 1_000;
    limiter.recordThrottle();
    now = 2_000;
    limiter.recordThrottle();
    expect(limiter.width).toBe(1);
  });

  test("a freed slot opens up when the width grows", async () => {
    const limiter = new AdaptiveConcurrencyLimiter({ ...policy, start: 1 });
    await limiter.acquire();
    let started = false;
    void limiter.acquire().then(() => {
      started = true;
    });

    limiter.recordSuccess();
    limiter.recordSuccess();
    await flush();
    expect(started).toBe(true);
  });

  test("a cancelled wait leaves the queue", async () => {
    const limiter = new AdaptiveConcurrencyLimiter({ ...policy, start: 1 });
    await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);

    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
  });

  test("a granted ceiling caps the start and the max", () => {
    expect(writerWidthPolicy(24)).toMatchObject({ start: 8, max: 24 });
    expect(writerWidthPolicy(4)).toMatchObject({ start: 4, max: 4 });
    expect(writerWidthPolicy(0)).toMatchObject({ start: 1, max: 1 });
    expect(DEFAULT_WRITER_WIDTH_POLICY).toMatchObject({ start: 8, max: 24 });
    expect(() => new AdaptiveConcurrencyLimiter({ ...policy, start: 9 })).toThrow(RangeError);
  });
});
