import { describe, expect, test, vi } from "vitest";
import {
  HOSTED_AGENT_TOOL_POLICY,
  route,
  type WorkerEnv,
} from "../src/worker-core";

describe("agent container Worker wrapper", () => {
  test("pins hosted generation to read-only agent tools", () => {
    expect(HOSTED_AGENT_TOOL_POLICY).toBe("read_only");
  });

  test("serves health without waking a container", async () => {
    const env = createEnv();

    const response = await route(new Request("https://agent-container.test/health"), env);

    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "doxa-agent-container-wrapper",
    });
    expect(env.AGENT_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid generation payloads", async () => {
    const env = createEnv();

    const response = await route(
      new Request("https://agent-container.test/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "11111111-1111-4111-8111-111111111111" }),
      }),
      env,
    );

    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: string };
    expect(payload.error).toBe("Invalid generation payload.");
    expect(env.AGENT_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  test("returns 400 before routing unsafe job IDs", async () => {
    const env = createEnv();

    const response = await route(
      new Request("https://agent-container.test/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validPayload(), jobId: "../unsafe" }),
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(env.AGENT_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  test("forwards valid generation payloads to a container selected by jobId", async () => {
    const containerFetchCalls: Request[] = [];
    const containerFetch = async (request: Request) => {
      containerFetchCalls.push(request);
      return Response.json({ ok: true, jobId: "11111111-1111-4111-8111-111111111111", files: [], events: [] });
    };
    const env = createEnv(containerFetch);

    const response = await route(
      new Request("https://agent-container.test/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(env.AGENT_CONTAINER.getByName).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(containerFetchCalls).toHaveLength(1);

    const forwarded = containerFetchCalls[0] as Request;
    expect(new URL(forwarded.url).pathname).toBe("/generate");
    expect(forwarded.method).toBe("POST");
    await expect(forwarded.json()).resolves.toEqual(validPayload());
  });

  test("forwards stream generation payloads to a container selected by jobId", async () => {
    const containerFetchCalls: Request[] = [];
    const containerFetch = async (request: Request) => {
      containerFetchCalls.push(request);
      return new Response(`${JSON.stringify({ kind: "error", error: { message: "stop" } })}\n`, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    };
    const env = createEnv(containerFetch);

    const response = await route(
      new Request("https://agent-container.test/generate/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(env.AGENT_CONTAINER.getByName).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(containerFetchCalls).toHaveLength(1);
    expect(new URL(containerFetchCalls[0]?.url ?? "").pathname).toBe("/generate/stream");
    expect(containerFetchCalls[0]?.method).toBe("POST");
  });

  test.each([
    ["analyze", { ...validPayload(), stage: "analysis" }],
    ["plan", { ...validPayload(), stage: "plan" }],
    ["structure", { ...validPayload(), stage: "structure", analysisCheckpoint: "{\"projectName\":\"Doxa\"}" }],
    ["write", {
      ...validPayload(),
      stage: "write",
      analysisCheckpoint: "{\"projectName\":\"Doxa\"}",
      structureCheckpoint: "{\"sections\":[]}",
      pageIds: ["overview"],
    }],
  ])("forwards the %s stage stream after validating its payload", async (stage, payload) => {
    const containerFetchCalls: Request[] = [];
    const env = createEnv(async (request) => {
      containerFetchCalls.push(request);
      return new Response(`${JSON.stringify({ kind: "error", error: { message: "stop" } })}\n`, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    });

    const response = await route(
      new Request(`https://agent-container.test/stages/${stage}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(env.AGENT_CONTAINER.getByName).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(new URL(containerFetchCalls[0]?.url ?? "").pathname).toBe(`/stages/${stage}/stream`);
    await expect(containerFetchCalls[0]?.json()).resolves.toEqual(payload);
  });

  test("rejects an empty staged write batch before waking a container", async () => {
    const env = createEnv();

    const response = await route(
      new Request("https://agent-container.test/stages/write/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...validPayload(),
          stage: "write",
          analysisCheckpoint: "{}",
          structureCheckpoint: "{}",
          pageIds: [],
        }),
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(env.AGENT_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  test("rejects invalid container destroy job ids before routing", async () => {
    const env = createEnv();

    const response = await route(
      new Request("https://agent-container.test/admin/containers/unsafe/destroy", {
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(env.AGENT_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  test("forwards container destroy to a container selected by jobId", async () => {
    const containerFetchCalls: Request[] = [];
    const env = createEnv(async (request) => {
      containerFetchCalls.push(request);
      return Response.json({ ok: true });
    });

    const response = await route(
      new Request("https://agent-container.test/admin/containers/11111111-1111-4111-8111-111111111111/destroy", {
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(env.AGENT_CONTAINER.getByName).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(new URL(containerFetchCalls[0]?.url ?? "").pathname).toBe("/admin/destroy");
  });

  test("passes through container error responses", async () => {
    const containerFetch = async () => Response.json({ error: "clone failed" }, { status: 500 });
    const env = createEnv(containerFetch);

    const response = await route(
      new Request("https://agent-container.test/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      }),
      env,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "clone failed" });
  });
});

function createEnv(
  fetchImpl: (request: Request) => Promise<Response> = vi.fn(async () => Response.json({ ok: true })),
): WorkerEnv {
  return {
    AGENT_CONTAINER: {
      getByName: vi.fn(() => ({
        fetch: fetchImpl,
      })),
    },
  };
}

function validPayload() {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
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
