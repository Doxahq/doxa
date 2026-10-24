import {
  containerGenerateRequestSchema,
  containerGenerationStageRequestSchema,
} from "@doxahq/contracts";
import type { AgentToolPolicy } from "@doxahq/agent";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const HOSTED_AGENT_TOOL_POLICY: AgentToolPolicy = "read_only";

export interface ContainerStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ContainerNamespace {
  getByName(name: string): ContainerStub;
}

export interface WorkerEnv {
  AGENT_CONTAINER: ContainerNamespace;
}

export function createAgentContainerWorker() {
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      return route(request, env);
    },
  };
}

export async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && pathname === "/health") {
    return Response.json({ ok: true, service: "doxa-agent-container-wrapper" });
  }

  const destroyMatch = pathname.match(/^\/admin\/containers\/([^/]+)\/destroy$/);
  if (destroyMatch && request.method === "POST") {
    const jobId = destroyMatch[1];
    if (!UUID_PATTERN.test(jobId)) {
      logWrapper("invalid_container_destroy_payload", { pathname });
      return Response.json({ error: "Invalid container job id." }, { status: 400 });
    }

    logWrapper("container_destroy_forwarding", { jobId });
    const container = env.AGENT_CONTAINER.getByName(jobId);
    return container.fetch(
      new Request(new URL("/admin/destroy", request.url), {
        method: "POST",
      }),
    );
  }

  if (request.method !== "POST" || (pathname !== "/generate" && pathname !== "/generate/stream")) {
    const stageMatch = pathname.match(/^\/stages\/(analyze|plan|structure|write)\/stream$/);
    if (!stageMatch || request.method !== "POST") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const rawStageInput = await request.json().catch(() => null);
    const parsedStage = containerGenerationStageRequestSchema.safeParse(rawStageInput);
    const expectedStage = stageMatch[1] === "analyze" ? "analysis" : stageMatch[1];
    if (!parsedStage.success || parsedStage.data.stage !== expectedStage) {
      logWrapper("invalid_generation_stage_payload", { pathname });
      return Response.json(
        { error: "Invalid generation stage payload.", ...(parsedStage.success ? {} : { details: parsedStage.error.flatten() }) },
        { status: 400 },
      );
    }

    logWrapper("container_stage_forwarding", {
      jobId: parsedStage.data.jobId,
      pathname,
      stage: parsedStage.data.stage,
    });
    const container = env.AGENT_CONTAINER.getByName(parsedStage.data.jobId);
    return container.fetch(
      new Request(new URL(pathname, request.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsedStage.data),
      }),
    );
  }

  const rawInput = await request.json().catch(() => null);
  const parsed = containerGenerateRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    logWrapper("invalid_generation_payload", { pathname });
    return Response.json(
      { error: "Invalid generation payload.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  logWrapper("container_forwarding", {
    jobId: parsed.data.jobId,
    pathname,
    stream: pathname === "/generate/stream",
  });
  const container = env.AGENT_CONTAINER.getByName(parsed.data.jobId);
  return container.fetch(
    new Request(new URL(pathname, request.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
    }),
  );
}

function logWrapper(eventType: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({
    service: "doxa-agent-container-wrapper",
    eventType,
    ...data,
  }));
}
