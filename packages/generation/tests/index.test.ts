import { afterEach, describe, expect, test, vi } from "vitest";
import { generationContextSchema } from "@doxahq/contracts";
import type { AgentContainerBinding, GenerationInternalApi } from "../src/index";
import {
  GenerationInfrastructureError,
  GenerationJobFailedError,
  requestAgentContainerDestroy,
  runRealGenerationJob,
} from "../src/index";

describe("runRealGenerationJob", () => {
  test("does not start the container after the job is cancelled", async () => {
    const calls = createCalls();
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "queue",
          internal: createInternalApi(calls, {
            isJobActive: async () => false,
          }),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: fetchImpl,
        },
      ),
    ).rejects.toThrow("Generation job is no longer active.");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.failed).toEqual([]);
  });

  test("aborts the container stream when the job is cancelled during generation", async () => {
    const calls = createCalls();
    const isJobActive = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    let requestSignal: AbortSignal | null | undefined;

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "queue",
          internal: createInternalApi(calls, { isJobActive }),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async (_url, init) => {
            requestSignal = init?.signal;
            return ndjsonResponse([
              {
                kind: "event",
                event: {
                  type: "analysis_progress",
                  message: "Still generating.",
                  source: "container",
                },
              },
              {
                kind: "result",
                result: {
                  ok: true,
                  jobId: "11111111-1111-4111-8111-111111111111",
                  files: validArtifactFiles(),
                },
              },
            ]);
          },
        },
      ),
    ).rejects.toThrow("Generation job is no longer active.");

    expect(requestSignal?.aborted).toBe(true);
    expect(calls.events).not.toContainEqual(expect.objectContaining({
      type: "analysis_progress",
    }));
    expect(calls.failed).toEqual([]);
  });

  test("preserves the cancelled state when the container reports an aborted generation", async () => {
    const calls = createCalls();
    const isJobActive = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "queue",
          internal: createInternalApi(calls, { isJobActive }),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async () => ndjsonResponse([
            {
              kind: "error",
              error: { message: "Generation cancelled by user." },
            },
          ]),
        },
      ),
    ).rejects.toThrow("Generation job is no longer active.");

    expect(calls.failed).toEqual([]);
  });

  test("aborts the container stream when a container heartbeat observes cancellation", async () => {
    const calls = createCalls();
    const isJobActive = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    let requestSignal: AbortSignal | null | undefined;

    await expect(runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "queue",
        internal: createInternalApi(calls, { isJobActive }),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        fetch: async (_url, init) => {
          requestSignal = init?.signal;
          return ndjsonResponse([
            { kind: "heartbeat", elapsedMs: 10_000 },
            {
              kind: "result",
              result: {
                ok: true,
                jobId: "11111111-1111-4111-8111-111111111111",
                files: validArtifactFiles(),
              },
            },
          ]);
        },
      },
    )).rejects.toThrow("Generation job is no longer active.");

    expect(requestSignal?.aborted).toBe(true);
    expect(isJobActive).toHaveBeenCalledTimes(2);
    expect(calls.failed).toEqual([]);
  });

  test("uses container heartbeats for liveness without persisting dashboard events", async () => {
    const calls = createCalls();

    await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "queue",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        fetch: async () => ndjsonResponse([
          { kind: "heartbeat", elapsedMs: 10_000 },
          {
            kind: "result",
            result: {
              ok: true,
              jobId: "11111111-1111-4111-8111-111111111111",
              files: validArtifactFiles(),
            },
          },
        ]),
      },
    );

    expect(calls.events).not.toContainEqual(expect.objectContaining({ type: "heartbeat" }));
    expect(calls.events).not.toContainEqual(expect.objectContaining({ type: "container_waiting" }));
  });

  test("uploads artifacts and publishes a valid generation result", async () => {
    const calls = createCalls();
    const internal = createInternalApi(calls);
    const artifacts: Array<{ path: string; content: string; contentType: string }> = [];
    const storageCalls: string[] = [];

    const result = await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal,
        artifacts: {
          commit: async (artifactPrefix) => {
            storageCalls.push(`commit ${artifactPrefix}`);
          },
          put: async (path, content, contentType) => {
            storageCalls.push("put");
            artifacts.push({ path, content, contentType });
          },
        },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        randomUUID: () => "version-1",
        fetch: async () =>
          Response.json({
            ok: true,
            jobId: "11111111-1111-4111-8111-111111111111",
            files: validArtifactFiles(),
            events: [
              {
                type: "analysis_started",
                message: "Analysis started with install-token and openrouter-secret.",
                data: { url: `https://x-access-token:${encodeURIComponent("install-token")}@github.com/repo.git` },
              },
            ],
          }),
      },
    );

    expect(result).toEqual({ versionId: "published-version-1" });
    expect(calls.running).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(calls.failed).toEqual([]);
    expect(calls.published).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        artifactPrefix: "sites/site-1/versions/version-1",
        manifestPath: "sites/site-1/versions/version-1/manifest.json",
      },
    ]);
    expect(artifacts.map((artifact) => artifact.path)).toContain(
      "sites/site-1/versions/version-1/manifest.json",
    );
    // The version becomes visible once, after its last file.
    expect(storageCalls.at(-1)).toBe("commit sites/site-1/versions/version-1");
    expect(storageCalls.filter((call) => call.startsWith("commit"))).toHaveLength(1);
    const analysisEvent = calls.events.find((event) => event.type === "analysis_started");
    expect(analysisEvent?.message).toBe("Analysis started with [redacted] and [redacted].");
    expect(JSON.stringify(analysisEvent?.data)).not.toContain("install-token");
  });

  test("sends the complete generation request to the agent container", async () => {
    const calls = createCalls();
    let requestBody: unknown;

    await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test/",
        openRouterApiKey: "openrouter-secret",
        model: "openai/gpt-4.1-mini",
        generationProfile: "fast-mvp",
        pageConcurrency: 6,
        randomUUID: () => "version-1",
        fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({
            ok: true,
            jobId: "11111111-1111-4111-8111-111111111111",
            files: validArtifactFiles(),
            events: [],
          });
        },
      },
    );

    expect(requestBody).toEqual({
      jobId: "11111111-1111-4111-8111-111111111111",
      repositoryFullName: "doxahq/doxa-demo",
      defaultBranch: "main",
      installationAccessToken: "install-token",
      modelProvider: "openrouter",
      modelApiKey: "openrouter-secret",
      model: "openai/gpt-4.1-mini",
      generationProfile: "fast-mvp",
      pageConcurrency: 6,
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
    });
  });

  test("passes published settings to the inline container", async () => {
    const calls = createCalls();
    const internal = createInternalApi(calls);
    const context = generationContextSchema.parse({
      ...await internal.getGenerationContext("project-1"),
      siteConfig: { name: "Custom docs", features: { apiPlayground: false } },
      entitlements: { removePoweredBy: true, maxBranchesPerSite: 10 },
    });
    internal.getGenerationContext = async () => context;
    let requestBody: unknown;
    await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal,
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test/",
        openRouterApiKey: "openrouter-secret",
        randomUUID: () => "version-1",
        fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({ ok: true, jobId: "11111111-1111-4111-8111-111111111111", files: validArtifactFiles(), events: [] });
        },
      },
    );
    expect(requestBody).toMatchObject({ siteConfig: context.siteConfig, entitlements: context.entitlements });
  });

  test("persists streamed container events before publishing", async () => {
    const calls = createCalls();

    const result = await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        randomUUID: () => "version-1",
        fetch: async () => ndjsonResponse([
          {
            kind: "event",
            event: {
              type: "clone_started",
              message: "Cloning repository.",
              data: { repositoryFullName: "doxahq/doxa-demo" },
            },
          },
          {
            kind: "event",
            event: {
              type: "analysis_progress",
              message: "Analyzing source files.",
              data: { progress: 42, currentItem: "src/index.ts" },
            },
          },
          {
            kind: "result",
            result: {
              ok: true,
              jobId: "11111111-1111-4111-8111-111111111111",
              files: validArtifactFiles(),
            },
          },
        ]),
      },
    );

    expect(result).toEqual({ versionId: "published-version-1" });
    expect(calls.events.map((event) => event.type)).toContain("clone_started");
    expect(calls.events.map((event) => event.type)).toContain("analysis_progress");
    expect(calls.timeline.indexOf("event:analysis_progress")).toBeLessThan(calls.timeline.indexOf("publish"));
  });

  test("redacts streamed container event secrets before persisting", async () => {
    const calls = createCalls();

    await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        randomUUID: () => "version-1",
        fetch: async () => ndjsonResponse([
          {
            kind: "event",
            event: {
              type: "clone_started",
              message: "Cloning with install-token and openrouter-secret.",
              data: { url: `https://x-access-token:${encodeURIComponent("install-token")}@github.com/repo.git` },
            },
          },
          {
            kind: "result",
            result: {
              ok: true,
              jobId: "11111111-1111-4111-8111-111111111111",
              files: validArtifactFiles(),
            },
          },
        ]),
      },
    );

    const event = calls.events.find((candidate) => candidate.type === "clone_started");
    expect(event?.message).toBe("Cloning with [redacted] and [redacted].");
    expect(JSON.stringify(event?.data)).not.toContain("install-token");
    expect(JSON.stringify(event?.data)).not.toContain("openrouter-secret");
  });

  test("marks stream error records as failed and does not publish", async () => {
    const calls = createCalls();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async () => ndjsonResponse([
            { kind: "event", event: { type: "clone_started", message: "Cloning repository." } },
            { kind: "error", error: { message: "clone failed with install-token" } },
          ]),
        },
      ),
    ).rejects.toThrow("clone failed with [redacted]");

    expect(calls.published).toEqual([]);
    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "clone failed with [redacted]",
      },
    ]);
  });

  test("marks malformed stream records as failed and does not publish", async () => {
    const calls = createCalls();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async () =>
            new Response("{not-json}\n", {
              headers: { "content-type": "application/x-ndjson; charset=utf-8" },
            }),
        },
      ),
    ).rejects.toThrow("Agent container stream returned malformed JSON.");

    expect(calls.published).toEqual([]);
  });

  test("does not upload or publish when a job is cancelled before artifact persistence", async () => {
    const calls = createCalls();
    const puts: string[] = [];

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls, {
            isJobActive: async () => false,
          }),
          artifacts: {
            commit: async () => undefined,
            put: async (path) => {
              puts.push(path);
            },
          },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          randomUUID: () => "version-1",
          fetch: async () => ndjsonResponse([
            {
              kind: "result",
              result: {
                ok: true,
                jobId: "11111111-1111-4111-8111-111111111111",
                files: validArtifactFiles(),
              },
            },
          ]),
        },
      ),
    ).rejects.toThrow("Generation job is no longer active.");

    expect(puts).toEqual([]);
    expect(calls.published).toEqual([]);
    expect(calls.failed).toEqual([]);
  });

  test("prefers the agent container binding over the URL fallback", async () => {
    const calls = createCalls();
    const fetchImpl = vi.fn();
    const bindingRequests: Request[] = [];
    const agentContainerBinding: AgentContainerBinding = {
      fetch: async (request) => {
        bindingRequests.push(request);
        return Response.json({
          ok: true,
          jobId: "11111111-1111-4111-8111-111111111111",
          files: validArtifactFiles(),
          events: [],
        });
      },
    };

    await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerBinding,
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        randomUUID: () => "version-1",
        fetch: fetchImpl,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(bindingRequests).toHaveLength(1);
    expect(bindingRequests[0]?.url).toBe("https://agent-container.internal/generate/stream");
    expect(bindingRequests[0]?.method).toBe("POST");
    expect(await bindingRequests[0]?.json()).toMatchObject({
      jobId: "11111111-1111-4111-8111-111111111111",
      repositoryFullName: "doxahq/doxa-demo",
      modelProvider: "openrouter",
      modelApiKey: "openrouter-secret",
    });
  });

  test("uses AGENT_CONTAINER_URL when no binding is provided", async () => {
    const calls = createCalls();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        jobId: "11111111-1111-4111-8111-111111111111",
        files: validArtifactFiles(),
        events: [],
      }),
    );

    await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test/",
        openRouterApiKey: "openrouter-secret",
        randomUUID: () => "version-1",
        fetch: fetchImpl,
      },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://agent-container.test/generate/stream");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  });

  test("falls back to AGENT_CONTAINER_URL when a local service binding is unavailable", async () => {
    const calls = createCalls();
    const agentContainerBinding: AgentContainerBinding = {
      fetch: vi.fn(async () => {
        throw new Error("service binding target is not running");
      }),
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        jobId: "11111111-1111-4111-8111-111111111111",
        files: validArtifactFiles(),
        events: [],
      }),
    );

    await runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerBinding,
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        randomUUID: () => "version-1",
        fetch: fetchImpl,
      },
    );

    expect(agentContainerBinding.fetch).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://agent-container.test/generate/stream");
    expect(calls.failed).toEqual([]);
  });

  test("marks an unavailable inline agent container with an actionable error", async () => {
    const calls = createCalls();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Network connection lost");
    });

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          randomUUID: () => "version-1",
          fetch: fetchImpl,
        },
      ),
    ).rejects.toThrow(
      "Agent container is unavailable. Ensure the configured agent container service is running and reachable.",
    );

    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message:
          "Agent container is unavailable. Ensure the configured agent container service is running and reachable.",
      },
    ]);
  });

  test("leaves agent transport failures retryable in queue mode", async () => {
    const calls = createCalls();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Network connection lost");
    });

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "queue",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          randomUUID: () => "version-1",
          fetch: fetchImpl,
        },
      ),
    ).rejects.toBeInstanceOf(GenerationInfrastructureError);

    expect(calls.failed).toEqual([]);
  });

  test("leaves retryable container pressure for the queue instead of marking the job failed", async () => {
    const calls = createCalls();
    const agentContainerBinding: AgentContainerBinding = {
      fetch: vi.fn(async () => Response.json({ error: "container capacity exceeded" }, { status: 503 })),
    };

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "queue",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerBinding,
          openRouterApiKey: "openrouter-secret",
          randomUUID: () => "version-1",
        },
      ),
    ).rejects.toBeInstanceOf(GenerationInfrastructureError);

    expect(calls.failed).toEqual([]);
    expect(calls.published).toEqual([]);
  });

  test("marks missing container transport as failed", async () => {
    const calls = createCalls();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          openRouterApiKey: "openrouter-secret",
        },
      ),
    ).rejects.toThrow(/internal agent container binding.*AGENT_CONTAINER_URL/);

    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message:
          "An internal agent container binding or AGENT_CONTAINER_URL is required for real docs generation.",
      },
    ]);
    expect(calls.published).toEqual([]);
  });

  test("marks missing provider key as failed and does not publish", async () => {
    const calls = createCalls();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
        },
      ),
    ).rejects.toThrow("OPENROUTER_API_KEY is required for real docs generation.");

    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "OPENROUTER_API_KEY is required for real docs generation.",
      },
    ]);
    expect(calls.published).toEqual([]);
  });

  test("rejects placeholder provider keys before requesting the agent container", async () => {
    const calls = createCalls();
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "your_key",
          fetch: fetchImpl,
        },
      ),
    ).rejects.toThrow("OPENROUTER_API_KEY must be configured with a real OpenRouter API key.");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "OPENROUTER_API_KEY must be configured with a real OpenRouter API key.",
      },
    ]);
  });

  test("marks missing generation context as failed before calling the container", async () => {
    const calls = createCalls();
    const fetchImpl = vi.fn();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls, {
            getGenerationContext: async () => null,
          }),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: fetchImpl,
        },
      ),
    ).rejects.toThrow("Generation context not found for project.");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "Generation context not found for project.",
      },
    ]);
    expect(calls.published).toEqual([]);
  });

  test("marks unsafe generated artifact paths as failed and does not publish", async () => {
    const calls = createCalls();
    const artifacts: Array<{ path: string; content: string; contentType: string }> = [];

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: {
            commit: async () => undefined,
            put: async (path, content, contentType) => {
              artifacts.push({ path, content, contentType });
            },
          },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async () =>
            Response.json({
              ok: true,
              jobId: "11111111-1111-4111-8111-111111111111",
              files: [
                ...validArtifactFiles(),
                { path: "../secret.mdx", content: "nope", contentType: "text/plain" },
              ],
              events: [],
            }),
        },
      ),
    ).rejects.toThrow("Generated artifact has an unsafe path: ../secret.mdx");

    expect(artifacts).toEqual([]);
    expect(calls.published).toEqual([]);
    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "Generated artifact has an unsafe path: ../secret.mdx",
      },
    ]);
  });

  test("marks invalid manifests as failed and does not publish", async () => {
    const calls = createCalls();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async () =>
            Response.json({
              ok: true,
              jobId: "11111111-1111-4111-8111-111111111111",
              files: [
                {
                  path: "manifest.json",
                  content: JSON.stringify({
                    siteId: "site-1",
                    versionId: "version-1",
                    projectSlug: "doxa-demo",
                    generatedAt: "2026-06-14T00:00:00.000Z",
                    pages: [{ title: "Missing", href: "/missing", sourcePath: "source/missing/index.mdx" }],
                  }),
                  contentType: "application/json; charset=utf-8",
                },
              ],
              events: [],
            }),
        },
      ),
    ).rejects.toThrow("Generated artifacts are missing page source: source/missing/index.mdx");

    expect(calls.published).toEqual([]);
    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "Generated artifacts are missing page source: source/missing/index.mdx",
      },
    ]);
  });

  test("rejects malformed page metadata before uploading artifacts", async () => {
    const calls = createCalls();
    const artifacts: Array<{ path: string; content: string; contentType: string }> = [];
    const malformedFiles = validArtifactFiles();
    malformedFiles[0] = {
      ...malformedFiles[0],
      content: [
        "---",
        "title: Product Context",
        "---",
        "",
        "## Product Context",
        "",
        'title: "Product Context" description: "Duplicated metadata" icon: "target"',
      ].join("\n"),
    };

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: {
            commit: async () => undefined,
            put: async (path, content, contentType) => {
              artifacts.push({ path, content, contentType });
            },
          },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async () => Response.json({
            ok: true,
            jobId: "11111111-1111-4111-8111-111111111111",
            files: malformedFiles,
            events: [],
          }),
        },
      ),
    ).rejects.toThrow(
      "Generated page source contains duplicated frontmatter metadata: source/index.mdx",
    );

    expect(artifacts).toEqual([]);
    expect(calls.published).toEqual([]);
  });

  test("redacts provider and installation tokens from failed container errors", async () => {
    const calls = createCalls();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async () =>
            Response.json(
              {
                error: "clone failed with install-token and openrouter-secret",
              },
              { status: 500 },
            ),
        },
      ),
    ).rejects.toThrow("clone failed with [redacted] and [redacted]");

    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "clone failed with [redacted] and [redacted]",
      },
    ]);
    expect(calls.published).toEqual([]);
  });

  test("marks invalid container responses as failed", async () => {
    const calls = createCalls();

    await expect(
      runRealGenerationJob(
        { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
        {
          mode: "container-inline",
          internal: createInternalApi(calls),
          artifacts: { put: async () => undefined, commit: async () => undefined },
          agentContainerUrl: "http://agent-container.test",
          openRouterApiKey: "openrouter-secret",
          fetch: async () =>
            Response.json({
              ok: true,
              jobId: "11111111-1111-4111-8111-111111111111",
              files: "not-files",
              events: [],
            }),
        },
      ),
    ).rejects.toThrow("Agent container returned an invalid generation response.");

    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "Agent container returned an invalid generation response.",
      },
    ]);
    expect(calls.published).toEqual([]);
  });

  test("marks container timeouts as failed", async () => {
    vi.useFakeTimers();
    const calls = createCalls();

    const promise = runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        timeoutMs: 50,
        fetch: async (url, init) => {
          if (new URL(String(url)).pathname.endsWith("/destroy")) {
            return Response.json({ ok: true });
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
        },
      },
    );

    const assertion = expect(promise).rejects.toThrow("Agent container timed out after 1 second.");
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(calls.published).toEqual([]);
    expect(calls.failed).toEqual([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "Agent container timed out after 1 second.",
      },
    ]);
  });

  test("aborts and destroys a container after 90 seconds without stream activity", async () => {
    vi.useFakeTimers();
    const calls = createCalls();
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname.endsWith("/destroy")) {
        return Response.json({ ok: true });
      }

      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const generation = runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "queue",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        timeoutMs: 120_000,
        fetch: fetchImpl,
      },
    );
    void generation.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(requestSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(generation).rejects.toThrow(
      "Agent container stopped responding for 90 seconds.",
    );
    expect(requestSignal?.aborted).toBe(true);
    expect(calls.failed).toEqual([{
      jobId: "11111111-1111-4111-8111-111111111111",
      message: "Agent container stopped responding for 90 seconds.",
    }]);
    expect(calls.events).toContainEqual(expect.objectContaining({
      type: "container_idle_timed_out",
      message: "Agent container stopped responding for 90 seconds.",
      data: expect.objectContaining({ idleTimeoutMs: 90_000, destroyRequested: true }),
    }));
    expect(calls.events).not.toContainEqual(expect.objectContaining({ type: "container_waiting" }));
  });

  test("enforces the hard deadline even while container heartbeats remain healthy", async () => {
    vi.useFakeTimers();
    const calls = createCalls();
    const generation = runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "queue",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        timeoutMs: 100_000,
        fetch: async (url) => {
          if (new URL(String(url)).pathname.endsWith("/destroy")) {
            return Response.json({ ok: true });
          }
          return timedHeartbeatResponse([30_000, 60_000, 90_000]);
        },
      },
    );
    void generation.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(100_001);

    await expect(generation).rejects.toThrow("Agent container timed out after 100 seconds.");
    expect(calls.events).toContainEqual(expect.objectContaining({ type: "container_timed_out" }));
    expect(calls.events).not.toContainEqual(expect.objectContaining({ type: "container_idle_timed_out" }));
  });

  test("replaces the local inline stage deadline when generation advances", async () => {
    vi.useFakeTimers();
    const calls = createCalls();
    const generation = runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "container-inline",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerUrl: "http://agent-container.test",
        openRouterApiKey: "openrouter-secret",
        timeoutMs: 120,
        overallTimeoutMs: 1_000,
        analysisTimeoutMs: 100,
        structureTimeoutMs: 100,
        pageBatchTimeoutMs: 100,
        finalizationTimeoutMs: 100,
        idleTimeoutMs: 1_000,
        randomUUID: () => "version-1",
        fetch: async () => timedGenerationResponse([
          { atMs: 50, record: generationEvent("analysis_started", "Analyzing repository.") },
          { atMs: 130, record: generationEvent("structure_started", "Creating structure.") },
          {
            atMs: 210,
            record: generationEvent("structure_created", "Structure created.", { pageCount: 65 }),
          },
          { atMs: 211, record: generationEvent("writing_started", "Writing pages.") },
          { atMs: 290, record: generationEvent("pages_written", "Pages written.") },
          {
            atMs: 340,
            record: {
              kind: "result",
              result: {
                ok: true,
                jobId: "11111111-1111-4111-8111-111111111111",
                files: validArtifactFiles(),
              },
            },
          },
        ]),
      },
    );
    const assertion = expect(generation).resolves.toEqual({ versionId: "published-version-1" });

    await vi.advanceTimersByTimeAsync(400);

    await assertion;
    expect(calls.failed).toEqual([]);
    expect(calls.published).toHaveLength(1);
  });

  test("enforces the deadline when the container response stream ignores abort and requests destroy", async () => {
    vi.useFakeTimers();
    const calls = createCalls();
    const binding: AgentContainerBinding = {
      fetch: vi.fn(async (request) => {
        if (new URL(request.url).pathname.endsWith("/destroy")) {
          calls.timeline.push("destroy");
          return Response.json({ ok: true });
        }

        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      }),
    };

    const promise = runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "queue",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerBinding: binding,
        openRouterApiKey: "openrouter-secret",
        timeoutMs: 50,
      },
    );
    let rejection: unknown;
    void promise.catch((error) => {
      rejection = error;
    });

    await vi.advanceTimersByTimeAsync(51);
    await Promise.resolve();

    expect(rejection).toBeInstanceOf(GenerationJobFailedError);
    await expect(promise).rejects.toThrow("Agent container timed out after 1 second.");
    expect(binding.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "https://agent-container.internal/admin/containers/11111111-1111-4111-8111-111111111111/destroy",
      }),
    );
    expect(calls.events).toContainEqual(expect.objectContaining({
      jobId: "11111111-1111-4111-8111-111111111111",
      type: "container_timed_out",
      message: "Agent container timed out after 1 second.",
      source: "worker",
    }));
    expect(calls.failed).toEqual([{
      jobId: "11111111-1111-4111-8111-111111111111",
      message: "Agent container timed out after 1 second.",
    }]);
    expect(calls.timeline.indexOf("failed")).toBeLessThan(calls.timeline.indexOf("destroy"));
  });

  test("marks queue timeouts failed even when the destroy request rejects", async () => {
    vi.useFakeTimers();
    const calls = createCalls();
    const binding: AgentContainerBinding = {
      fetch: vi.fn((request) => {
        if (new URL(request.url).pathname.endsWith("/destroy")) {
          return Promise.reject(new Error("destroy unavailable"));
        }
        return new Promise<Response>(() => undefined);
      }),
    };

    const promise = runRealGenerationJob(
      { jobId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      {
        mode: "queue",
        internal: createInternalApi(calls),
        artifacts: { put: async () => undefined, commit: async () => undefined },
        agentContainerBinding: binding,
        openRouterApiKey: "openrouter-secret",
        timeoutMs: 50,
      },
    );
    let rejection: unknown;
    void promise.catch((error) => {
      rejection = error;
    });

    await vi.advanceTimersByTimeAsync(51);
    await Promise.resolve();

    expect(rejection).toBeInstanceOf(GenerationJobFailedError);
    expect(calls.failed).toEqual([{
      jobId: "11111111-1111-4111-8111-111111111111",
      message: "Agent container timed out after 1 second.",
    }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("requestAgentContainerDestroy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("falls back to the configured URL when the local service binding is unavailable", async () => {
    const binding: AgentContainerBinding = {
      fetch: vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })),
    };
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));

    await expect(
      requestAgentContainerDestroy("11111111-1111-4111-8111-111111111111", {
        agentContainerBinding: binding,
        agentContainerUrl: "http://localhost:8789/",
        fetch: fetchImpl,
      }),
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8789/admin/containers/11111111-1111-4111-8111-111111111111/destroy",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("bounds an unresponsive binding before using the URL fallback", async () => {
    vi.useFakeTimers();
    const binding: AgentContainerBinding = {
      fetch: vi.fn((request) => new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })),
    };
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const cancellation = requestAgentContainerDestroy(
      "11111111-1111-4111-8111-111111111111",
      {
        agentContainerBinding: binding,
        agentContainerUrl: "http://localhost:8789",
        fetch: fetchImpl,
      },
    );

    await vi.advanceTimersByTimeAsync(2_001);

    await expect(cancellation).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

function createCalls() {
  return {
    running: [] as string[],
    failed: [] as Array<{ jobId: string; message: string }>,
    events: [] as Array<{ jobId: string; type: string; message: string; data?: Record<string, unknown>; source?: string }>,
    published: [] as Array<{ jobId: string; artifactPrefix: string; manifestPath: string }>,
    timeline: [] as string[],
  };
}

function createInternalApi(
  calls: ReturnType<typeof createCalls>,
  overrides: Partial<GenerationInternalApi> = {},
): GenerationInternalApi {
  return {
    getGenerationContext: async () => ({
      project: {
        id: "project-1",
        name: "Doxa Demo",
        slug: "doxa-demo",
        siteId: "site-1",
        siteSlug: "doxa-demo",
      },
      repository: {
        id: "repo-1",
        fullName: "doxahq/doxa-demo",
        defaultBranch: "main",
        installationId: "installation-1",
      },
    }),
    createInstallationAccessToken: async () => "install-token",
    markJobRunning: async (jobId) => {
      calls.running.push(jobId);
      calls.timeline.push("running");
    },
    markJobFailed: async (jobId, message) => {
      calls.failed.push({ jobId, message });
      calls.timeline.push("failed");
    },
    markJobCancelled: async () => undefined,
    isJobActive: async () => true,
    getGenerationControl: async () => ({
      status: "enabled",
      reason: null,
      updatedByUserId: null,
      updatedAt: null,
    }),
    listStaleGenerationJobs: async () => [],
    addJobEvent: async (jobId, type, message, data, source) => {
      calls.events.push({ jobId, type, message, data, source });
      calls.timeline.push(`event:${type}`);
    },
    publishJobOutput: async (input) => {
      calls.published.push(input);
      calls.timeline.push("publish");
      return { versionId: "published-version-1" };
    },
    ...overrides,
  };
}

function ndjsonResponse(records: unknown[]) {
  return new Response(records.map((record) => JSON.stringify(record)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

function timedHeartbeatResponse(scheduleMs: number[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const elapsedMs of scheduleMs) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "heartbeat", elapsedMs })}\n`));
        }, elapsedMs);
      }
    },
  }), {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

function generationEvent(
  type: string,
  message: string,
  data?: Record<string, unknown>,
) {
  return { kind: "event", event: { type, message, source: "container", data } };
}

function timedGenerationResponse(
  schedule: Array<{ atMs: number; record: unknown }>,
): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of schedule) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(`${JSON.stringify(item.record)}\n`));
          if (item === schedule.at(-1)) controller.close();
        }, item.atMs);
      }
    },
  }), {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

function validArtifactFiles() {
  return [
    {
      path: "source/index.mdx",
      content: "---\ntitle: Doxa Demo\n---\n\n# Doxa Demo\n",
      contentType: "text/plain; charset=utf-8",
    },
    {
      path: "manifest.json",
      content: JSON.stringify({
        siteId: "site-1",
        versionId: "version-1",
        projectSlug: "doxa-demo",
        generatedAt: "2026-06-14T00:00:00.000Z",
        pages: [{ title: "Doxa Demo", href: "/", sourcePath: "source/index.mdx" }],
      }),
      contentType: "application/json; charset=utf-8",
    },
  ];
}
