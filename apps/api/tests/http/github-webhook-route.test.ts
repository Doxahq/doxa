import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const mocks = vi.hoisted(() => ({
  verifyGitHubWebhook: vi.fn(),
  ingestWebhook: vi.fn(),
  processDelivery: vi.fn(),
}));

vi.mock("../../src/services/github-webhook", () => ({
  verifyGitHubWebhook: mocks.verifyGitHubWebhook,
}));

vi.mock("../../src/services/doxabot/webhook-orchestrator", () => ({
  DoxabotWebhookOrchestrator: {
    fromEnv: vi.fn(() => ({
      ingest: mocks.ingestWebhook,
      processDelivery: mocks.processDelivery,
    })),
  },
}));

import { createGitHubRoutes } from "../../src/routes/github";

const app = createGitHubRoutes();
let waitUntil: ReturnType<typeof vi.fn>;

function requestWebhook(request: Request): Promise<Response> {
  return Promise.resolve(
    app.request(
      request,
      undefined,
      undefined,
      { waitUntil } as never,
    ),
  );
}

function webhookRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://api.doxa.so/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("GitHub webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    waitUntil = vi.fn();
    mocks.verifyGitHubWebhook.mockResolvedValue(true);
    mocks.ingestWebhook.mockResolvedValue({ outcome: "claimed" });
    mocks.processDelivery.mockResolvedValue({
      outcome: "enqueued",
      jobId: "job-1",
    });
  });

  test("requires delivery and event headers before reading the signature", async () => {
    const response = await requestWebhook(webhookRequest("{}"));

    expect(response.status).toBe(400);
    expect(mocks.verifyGitHubWebhook).not.toHaveBeenCalled();
    expect(mocks.ingestWebhook).not.toHaveBeenCalled();
    expect(mocks.processDelivery).not.toHaveBeenCalled();
  });

  test("verifies the signature over the raw body before orchestration", async () => {
    mocks.verifyGitHubWebhook.mockResolvedValueOnce(false);
    const rawBody = "{not-json";
    const request = webhookRequest(rawBody, {
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": "sha256=invalid",
    });

    const response = await requestWebhook(request);

    expect(response.status).toBe(401);
    expect(mocks.verifyGitHubWebhook).toHaveBeenCalledWith(
      request,
      undefined,
      rawBody,
    );
    expect(mocks.ingestWebhook).not.toHaveBeenCalled();
    expect(mocks.processDelivery).not.toHaveBeenCalled();
  });

  test("acknowledges authenticated deliveries before orchestration completes", async () => {
    let finishProcessing: (() => void) | undefined;
    mocks.processDelivery.mockReturnValueOnce(
      new Promise((resolve) => {
        finishProcessing = () => resolve({
          outcome: "enqueued",
          jobId: "job-1",
        });
      }),
    );
    const rawBody = JSON.stringify({ action: "opened" });
    const response = await requestWebhook(
      webhookRequest(rawBody, {
        "x-github-delivery": "delivery-2",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
      }),
    );

    expect(response.status).toBe(202);
    expect(mocks.ingestWebhook).toHaveBeenCalledWith({
      deliveryId: "delivery-2",
      eventName: "pull_request",
      rawBody,
    });
    expect(mocks.processDelivery).toHaveBeenCalledWith({
      provider: "github",
      deliveryId: "delivery-2",
    });
    expect(waitUntil).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      outcome: "accepted",
    });
    finishProcessing?.();
  });

  test("does not ask GitHub to retry malformed authenticated payloads", async () => {
    mocks.processDelivery.mockResolvedValueOnce({
      outcome: "malformed",
      reason: "invalid_payload",
    });

    const response = await requestWebhook(
      webhookRequest("{not-json", {
        "x-github-delivery": "delivery-3",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
      }),
    );

    expect(response.status).toBe(202);
    expect(waitUntil).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      outcome: "accepted",
    });
  });

  test("acknowledges duplicate deliveries without scheduling work", async () => {
    mocks.ingestWebhook.mockResolvedValueOnce({ outcome: "duplicate" });

    const response = await requestWebhook(
      webhookRequest("{}", {
        "x-github-delivery": "delivery-4",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.processDelivery).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      outcome: "duplicate",
    });
  });

  test("does not acknowledge a delivery when durable ingress fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.ingestWebhook.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const response = await requestWebhook(
      webhookRequest("{}", {
        "x-github-delivery": "delivery-5",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
      }),
    );

    expect(response.status).toBe(500);
    expect(mocks.processDelivery).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
