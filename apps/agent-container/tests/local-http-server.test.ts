import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLocalAgentServer } from "../src/local-http-server";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const servers: ReturnType<typeof createLocalAgentServer>[] = [];

describe("local agent container server", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
  });

  test("aborts the active generation when its destroy endpoint is called", async () => {
    let resolveStarted: ((controller: AbortController) => void) | undefined;
    const started = new Promise<AbortController>((resolve) => {
      resolveStarted = resolve;
    });
    const server = createLocalAgentServer({
      generate: vi.fn(),
      streamGeneration: async (response, _input, controller) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        resolveStarted?.(controller);
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        response.end(`${JSON.stringify({ kind: "error", error: { message: "Generation cancelled by user." } })}\n`);
      },
      streamGenerationStage: vi.fn(),
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const generationResponse = fetch(`${baseUrl}/generate/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload()),
    });
    const controller = await started;

    const destroyResponse = await fetch(`${baseUrl}/admin/containers/${JOB_ID}/destroy`, {
      method: "POST",
    });

    expect(destroyResponse.status).toBe(200);
    await expect(destroyResponse.json()).resolves.toEqual({ ok: true, stopped: true });
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toEqual(new Error("Generation cancelled by user."));
    expect((await generationResponse).status).toBe(200);
  });

  test("rejects a generation that arrives after its destroy request", async () => {
    const streamGeneration = vi.fn();
    const server = createLocalAgentServer({
      generate: vi.fn(),
      streamGeneration,
      streamGenerationStage: vi.fn(),
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const destroyResponse = await fetch(`${baseUrl}/admin/containers/${JOB_ID}/destroy`, {
      method: "POST",
    });
    const generationResponse = await fetch(`${baseUrl}/generate/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload()),
    });

    await expect(destroyResponse.json()).resolves.toEqual({ ok: true, stopped: false });
    expect(generationResponse.status).toBe(409);
    await expect(generationResponse.json()).resolves.toEqual({
      error: "Generation was cancelled before it started.",
    });
    expect(streamGeneration).not.toHaveBeenCalled();
  });

  test("routes a validated write stage to the staged generation handler", async () => {
    const streamGenerationStage = vi.fn(async (
      response: Parameters<Parameters<typeof createLocalAgentServer>[0]["streamGenerationStage"]>[0],
      _input: Parameters<Parameters<typeof createLocalAgentServer>[0]["streamGenerationStage"]>[1],
      _controller: Parameters<Parameters<typeof createLocalAgentServer>[0]["streamGenerationStage"]>[2],
    ) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({ kind: "stage_result", result: { stage: "write", pages: [] } })}\n`);
    });
    const server = createLocalAgentServer({
      generate: vi.fn(),
      streamGeneration: vi.fn(),
      streamGenerationStage,
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/stages/write/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validPayload(),
        stage: "write",
        analysisCheckpoint: "{}",
        structureCheckpoint: "{}",
        pageIds: ["overview"],
      }),
    });

    expect(response.status).toBe(200);
    expect(streamGenerationStage).toHaveBeenCalledOnce();
    expect(streamGenerationStage.mock.calls[0]?.[1]).toMatchObject({
      jobId: JOB_ID,
      stage: "write",
      pageIds: ["overview"],
    });
  });

  test("routes a validated plan stage to the staged generation handler", async () => {
    const streamGenerationStage = vi.fn(async (
      response: Parameters<Parameters<typeof createLocalAgentServer>[0]["streamGenerationStage"]>[0],
      _input: Parameters<Parameters<typeof createLocalAgentServer>[0]["streamGenerationStage"]>[1],
      _controller: Parameters<Parameters<typeof createLocalAgentServer>[0]["streamGenerationStage"]>[2],
    ) => {
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
      });
      response.end(`${JSON.stringify({
        kind: "stage_result",
        result: {
          stage: "plan",
          analysisCheckpoint: "{}",
          structureCheckpoint: "{\"sections\":[]}",
          pageIds: ["overview"],
          pageInputHashes: { overview: "a".repeat(64) },
          routeRegistryHash: "b".repeat(64),
          navigation: { sections: [] },
        },
      })}\n`);
    });
    const server = createLocalAgentServer({
      generate: vi.fn(),
      streamGeneration: vi.fn(),
      streamGenerationStage,
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/stages/plan/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validPayload(),
        stage: "plan",
      }),
    });

    expect(response.status).toBe(200);
    expect(streamGenerationStage).toHaveBeenCalledOnce();
    expect(streamGenerationStage.mock.calls[0]?.[1]).toMatchObject({
      jobId: JOB_ID,
      stage: "plan",
    });
  });
});

async function listen(server: ReturnType<typeof createLocalAgentServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function validPayload() {
  return {
    jobId: JOB_ID,
    repositoryFullName: "doxahq/doxa-demo",
    defaultBranch: "main",
    installationAccessToken: "install-token",
    modelProvider: "openrouter",
    modelApiKey: "openrouter-key",
    model: "openai/gpt-4.1-mini",
    generationProfile: "fast-mvp",
    pageConcurrency: 6,
    maxPages: 18,
    siteId: "site-1",
    versionId: "version-1",
    projectSlug: "doxa-demo",
    projectName: "Doxa Demo",
  };
}
