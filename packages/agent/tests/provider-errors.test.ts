import { describe, expect, test } from "vitest";

import { runErrorFinishReason, runErrorMessage } from "../src/core/provider-errors";

describe("runErrorFinishReason", () => {
  test("reads Anthropic's stop at the token limit as a length finish", () => {
    const message = "The response was cut off because the maximum token limit was reached.";
    expect(runErrorFinishReason({ message, code: "max_tokens" })).toBe("length");
    expect(runErrorFinishReason({ error: { message, code: "max_tokens" } })).toBe("length");
  });

  test("leaves every other error a failure", () => {
    expect(runErrorFinishReason({ message: "Provider returned error", code: 400 })).toBeNull();
    expect(runErrorFinishReason({ message: "Overloaded" })).toBeNull();
  });
});

describe("runErrorMessage", () => {
  test("keeps the upstream reason from an OpenRouter error object", () => {
    expect(runErrorMessage({
      message: "Provider returned error",
      code: 400,
      rawEvent: {
        code: 400,
        message: "Provider returned error",
        metadata: {
          provider_name: "Anthropic",
          raw: JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "prompt is too long" },
          }),
        },
      },
    })).toBe("Provider returned error (code 400; Anthropic: prompt is too long)");
  });

  test("reads OpenRouter metadata sent without its error object", () => {
    expect(runErrorMessage({
      message: "Provider returned error",
      rawEvent: { provider_name: "Anthropic", raw: "upstream timed out" },
    })).toBe("Provider returned error (Anthropic: upstream timed out)");
  });

  test("keeps the plain message when the chunk has no detail", () => {
    expect(runErrorMessage({ message: "Provider returned error" })).toBe("Provider returned error");
    expect(runErrorMessage({ error: { message: "Rate limited", code: "429" } })).toBe(
      "Rate limited (code 429)",
    );
    expect(runErrorMessage({})).toBe("Provider stream failed");
  });

  test("does not repeat a reason equal to the message and shortens long reasons", () => {
    expect(runErrorMessage({
      message: "Provider returned error",
      rawEvent: { message: "Provider returned error" },
    })).toBe("Provider returned error");

    const message = runErrorMessage({ message: "Provider returned error", rawEvent: { raw: "x".repeat(600) } });
    expect(message).toBe(`Provider returned error (${"x".repeat(500)}...)`);
  });
});
