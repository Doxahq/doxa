import { afterEach, describe, expect, test, vi } from "vitest";
import type { WriterDiagnosticEvent } from "@doxahq/agent";
import { createWriterDiagnosticLogger } from "../src/logging";

describe("writer diagnostic logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("writes structured terminal diagnostics with secrets redacted", () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message) => {
      output.push(String(message));
    });
    const logDiagnostic = createWriterDiagnosticLogger({
      jobId: "job-123",
      installationAccessToken: "github-secret",
      modelApiKey: "openrouter-secret",
    });
    const event: WriterDiagnosticEvent = {
      eventType: "writer_model_failed",
      pageTitle: "Overview",
      pageRetry: 0,
      attempt: 2,
      maxAttempts: 3,
      durationMs: 42_000,
      errorName: "ProviderError",
      errorMessage: "github-secret and openrouter-secret were rejected",
    };

    logDiagnostic(event);

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toEqual({
      service: "doxa-agent-writer",
      jobId: "job-123",
      eventType: "writer_model_failed",
      pageTitle: "Overview",
      pageRetry: 0,
      attempt: 2,
      maxAttempts: 3,
      durationMs: 42_000,
      errorName: "ProviderError",
      errorMessage: "[redacted] and [redacted] were rejected",
    });
  });
});
