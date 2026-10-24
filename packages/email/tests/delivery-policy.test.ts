import { describe, expect, it } from "vitest";
import { decideDelivery, emailFailed, emailSent, type EmailFailureKind } from "../src";

const failure = (kind: EmailFailureKind) => emailFailed("cloudflare", kind, "x");

describe("decideDelivery", () => {
  it("completes a sent email", () => {
    expect(decideDelivery(emailSent("cloudflare", "m1"), 1)).toEqual({ action: "complete", status: "sent" });
  });

  it.each([
    ["invalid_message", "failed"],
    ["configuration", "failed"],
    ["rejected", "failed"],
    ["recipient_suppressed", "suppressed"],
  ] as const)("does not retry %s", (kind, status) => {
    expect(decideDelivery(failure(kind), 1)).toEqual({ action: "complete", status });
  });

  it("waits one minute after a rate limit", () => {
    expect(decideDelivery(failure("rate_limited"), 3)).toEqual({ action: "retry", delaySeconds: 60 });
  });

  it("doubles the delay after an outage, up to one hour", () => {
    expect([1, 2, 3, 7].map((attempt) => decideDelivery(failure("unavailable"), attempt))).toEqual([
      { action: "retry", delaySeconds: 30 },
      { action: "retry", delaySeconds: 60 },
      { action: "retry", delaySeconds: 120 },
      { action: "retry", delaySeconds: 1920 },
    ]);
  });

  it("retries a used-up quota each hour for 24 attempts", () => {
    expect(decideDelivery(failure("quota_exceeded"), 23)).toEqual({ action: "retry", delaySeconds: 3600 });
    expect(decideDelivery(failure("quota_exceeded"), 24)).toEqual({ action: "complete", status: "failed" });
  });

  it("fails after the last attempt", () => {
    expect(decideDelivery(failure("unavailable"), 8)).toEqual({ action: "complete", status: "failed" });
    expect(decideDelivery(failure("rate_limited"), 8)).toEqual({ action: "complete", status: "failed" });
  });
});
