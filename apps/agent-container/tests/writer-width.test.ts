import { describe, expect, test } from "vitest";
import { releaseWriterLimiter, throttleOnRetry, writerLimiterForJob } from "../src/writer-width";

const retry = (errorClass: "rate_limited" | "overloaded" | "server_error") => ({
  attempt: 1,
  delayMs: 0,
  errorClass,
  reason: errorClass,
});

describe("writer width per job", () => {
  test("write groups of one job share one limiter, and a new grant changes its ceiling", () => {
    const first = writerLimiterForJob("job-a", 24);
    const second = writerLimiterForJob("job-a", 12);

    expect(second).toBe(first);
    expect(first.max).toBe(12);
    expect(writerLimiterForJob("job-b", 24)).not.toBe(first);
    releaseWriterLimiter("job-a");
    releaseWriterLimiter("job-b");
    expect(writerLimiterForJob("job-a", 24)).not.toBe(first);
    releaseWriterLimiter("job-a");
  });

  test("only a rate limit or an overload lowers the width", () => {
    const limiter = writerLimiterForJob("job-c", 24);
    const onRetry = throttleOnRetry(limiter);

    onRetry(retry("server_error"));
    expect(limiter.width).toBe(8);
    onRetry(retry("overloaded"));
    expect(limiter.width).toBe(4);
    releaseWriterLimiter("job-c");
  });
});
