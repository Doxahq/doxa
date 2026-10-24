import { describe, expect, test } from "vitest";
import { jobFailure, jobSuccess, parseJobOutcome } from "../src/outcome";

describe("job outcome", () => {
  test("reads a success and a failure", () => {
    expect(parseJobOutcome(JSON.stringify(jobSuccess({ count: 2 })))).toEqual({ ok: true, output: { count: 2 } });
    expect(parseJobOutcome(JSON.stringify(jobFailure("invalid_input", "No roots.")))).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "No roots." },
    });
  });

  test.each([
    ["text that is not JSON", "not json"],
    ["an array", "[]"],
    ["a success without output", JSON.stringify({ ok: true })],
    ["a failure with an unknown code", JSON.stringify({ ok: false, error: { code: "pwned", message: "x" } })],
    ["a failure without a message", JSON.stringify({ ok: false, error: { code: "timeout" } })],
  ])("turns %s into invalid_output", (_label, text) => {
    const outcome = parseJobOutcome(text);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? undefined : outcome.error.code).toBe("invalid_output");
  });

  test("caps the length of an error message", () => {
    const outcome = jobFailure("job_failed", "x".repeat(10_000));

    expect(outcome.ok ? 0 : outcome.error.message.length).toBe(500);
  });
});
