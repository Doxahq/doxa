import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { runJobChild, type JobChildSpec } from "./job-child";
import { jobFailure, type JobOutcome } from "./outcome";

export interface SupervisorOptions extends JobChildSpec {
  /** The job name, for logs. */
  job: string;
  port: number;
  maxRequestBytes: number;
  maxOutputBytes: number;
  /** The job child is killed after this time. */
  timeoutMs: number;
}

/** The only route of a job image. */
export const JOB_RUN_PATH = "/run";

/**
 * The process of a job image. It accepts `POST /run`, counts the request
 * bytes and runs one job child at a time. It parses nothing itself and
 * logs counts and codes only, never input text.
 */
export function startSupervisor(options: SupervisorOptions): Server {
  let running = false;

  const server = createServer(async (request, response) => {
    if (request.url !== JOB_RUN_PATH) return sendStatus(response, 404);
    if (request.method !== "POST") return sendStatus(response, 405);
    if (running) {
      return sendOutcome(response, 429, jobFailure("busy", "The job already runs a call."));
    }

    running = true;
    const startedAt = Date.now();
    try {
      const input = await readRequestBody(request, options.maxRequestBytes);
      const outcome = input
        ? await runJobChild({ ...options, input })
        : jobFailure("input_too_large", `The input is larger than ${options.maxRequestBytes} bytes.`);
      logCall(options.job, {
        ok: outcome.ok,
        code: outcome.ok ? undefined : outcome.error.code,
        inputBytes: input?.byteLength,
        durationMs: Date.now() - startedAt,
      });
      sendOutcome(response, input ? 200 : 413, outcome);
    } finally {
      running = false;
    }
  });
  server.listen(options.port);
  return server;
}

/** The body, or undefined when it is larger than the limit. */
async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    return undefined;
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    receivedBytes += bytes.byteLength;
    if (receivedBytes > maxBytes) {
      request.resume();
      return undefined;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sendOutcome(response: ServerResponse, status: number, outcome: JobOutcome<unknown>): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(outcome));
}

function sendStatus(response: ServerResponse, status: number): void {
  response.writeHead(status).end();
}

function logCall(job: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ service: "doxa-utility-job", job, eventType: "job_call_finished", ...data }));
}
