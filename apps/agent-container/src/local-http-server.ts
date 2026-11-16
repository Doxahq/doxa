import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  containerGenerateRequestSchema,
  containerGenerationStageRequestSchema,
  type ContainerGenerateRequest,
  type ContainerGenerateResponse,
  type ContainerGenerationStageRequest,
} from "@doxahq/contracts";
import { ActiveGenerationRequests } from "./active-generation-requests";
import { outputSecrets, registerActiveSecrets, sanitizeText, sanitizeValue } from "./logging";
import { bindGenerationRequestCancellation } from "./request-cancellation";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LocalAgentHandlers {
  generate(
    input: ContainerGenerateRequest,
    abortController: AbortController,
  ): Promise<ContainerGenerateResponse>;
  streamGeneration(
    response: ServerResponse,
    input: ContainerGenerateRequest,
    abortController: AbortController,
  ): Promise<void>;
  streamGenerationStage(
    response: ServerResponse,
    input: ContainerGenerationStageRequest,
    abortController: AbortController,
  ): Promise<void>;
}

export function createLocalAgentServer(handlers: LocalAgentHandlers): Server {
  const activeRequests = new ActiveGenerationRequests();

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://agent-container.local");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "doxa-agent-container" });
      return;
    }

    const destroyMatch = pathname.match(/^\/admin\/containers\/([^/]+)\/destroy$/);
    if (request.method === "POST" && destroyMatch) {
      const jobId = destroyMatch[1];
      if (!UUID_PATTERN.test(jobId)) {
        sendJson(response, 400, { error: "Invalid container job id." });
        return;
      }

      // `resumable=1`: the job can continue, so its next request must run.
      const stopped = url.searchParams.get("resumable") === "1"
        ? activeRequests.stop(jobId)
        : activeRequests.cancel(jobId);
      sendJson(response, 200, { ok: true, stopped });
      return;
    }

    const stageRoute = pathname.match(/^\/stages\/(analyze|plan|structure|write)\/stream$/);
    const isGenerateRoute = pathname === "/generate" || pathname === "/generate/stream";
    if (request.method !== "POST" || (!isGenerateRoute && !stageRoute)) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const cancellation = bindGenerationRequestCancellation(request, response);
    let registeredJobId: string | null = null;
    // Set once the request parses. Every response and log line masks them.
    let secrets: string[] = [];
    let releaseSecrets = () => {};
    try {
      const rawInput = await readJson<unknown>(request);
      let input: ContainerGenerateRequest | ContainerGenerationStageRequest;
      if (stageRoute) {
        const parsed = containerGenerationStageRequestSchema.safeParse(rawInput);
        if (!parsed.success) {
          sendJson(response, 400, { error: "Invalid generation payload.", details: parsed.error.flatten() });
          return;
        }
        const expectedStage = stageRoute[1] === "analyze" ? "analysis" : stageRoute[1];
        if (parsed.data.stage !== expectedStage) {
          sendJson(response, 400, { error: "Generation stage does not match request path." });
          return;
        }
        input = parsed.data;
      } else {
        const parsed = containerGenerateRequestSchema.safeParse(rawInput);
        if (!parsed.success) {
          sendJson(response, 400, { error: "Invalid generation payload.", details: parsed.error.flatten() });
          return;
        }
        input = parsed.data;
      }

      secrets = outputSecrets(input);
      releaseSecrets = registerActiveSecrets(secrets);

      if (!activeRequests.register(input.jobId, cancellation.abortController)) {
        sendJson(response, 409, { error: "Generation was cancelled before it started." });
        return;
      }
      registeredJobId = input.jobId;

      if (stageRoute) {
        await handlers.streamGenerationStage(
          response,
          input as ContainerGenerationStageRequest,
          cancellation.abortController,
        );
        return;
      }

      if (pathname === "/generate/stream") {
        await handlers.streamGeneration(
          response,
          input as ContainerGenerateRequest,
          cancellation.abortController,
        );
        return;
      }

      const result = await handlers.generate(
        input as ContainerGenerateRequest,
        cancellation.abortController,
      );
      sendJson(response, 200, sanitizeValue(result, secrets));
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: sanitizeText(error instanceof Error ? error.message : "Generation failed", secrets),
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      if (registeredJobId) {
        activeRequests.unregister(registeredJobId, cancellation.abortController);
      }
      releaseSecrets();
      cancellation.dispose();
    }
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}
