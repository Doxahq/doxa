import { UUID_PATTERN } from "../worker-core";
import {
  isUtilityJobName,
  UTILITY_JOBS,
  type UtilityJobBinding,
  type UtilityJobName,
} from "./registry";

/** A job container instance, as the gate calls it. */
export interface UtilityJobStub {
  fetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
}

export interface UtilityJobNamespace {
  getByName(name: string): UtilityJobStub;
}

export type UtilityGateEnv = Record<UtilityJobBinding, UtilityJobNamespace>;

/** `POST /v1/jobs/<job>/run` calls a job; `POST /v1/jobs/<job>/done` ends its instance. */
const JOB_PATH = /^\/v1\/jobs\/([a-z][a-z0-9-]{0,39})\/(run|done)$/;
export const RUN_ID_HEADER = "x-doxa-run-id";
/** The only request headers that reach a job. Keys and tokens never do. */
const PASSED_HEADERS = ["content-type", "content-length"] as const;

/**
 * The gate between the agent container and the utility jobs. It runs in the
 * Workers runtime, outside both VMs, as an outbound handler of the agent
 * container: the public fetch handler of the Worker never reaches a job.
 * One instance serves one run of one job, and `done` destroys it.
 */
export async function utilityGate(request: Request, env: UtilityGateEnv): Promise<Response> {
  const match = JOB_PATH.exec(new URL(request.url).pathname);
  const jobName = match?.[1];
  if (!match || !jobName || !isUtilityJobName(jobName)) return status(404);
  if (request.method !== "POST") return status(405);
  const runId = request.headers.get(RUN_ID_HEADER) ?? "";
  if (!UUID_PATTERN.test(runId)) return status(400);

  const job = UTILITY_JOBS[jobName];
  const instance = env[job.binding].getByName(instanceName(jobName, runId));
  if (match[2] === "done") {
    await instance.destroy();
    return status(204);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null || !/^\d+$/.test(declaredLength)) return status(411);
  if (Number(declaredLength) > job.maxRequestBytes) return status(413);

  // Node needs `duplex` to stream a request body; the Workers runtime ignores it.
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: passedHeaders(request.headers),
    body: request.body,
    signal: AbortSignal.timeout(job.timeoutMs),
    duplex: "half",
  };
  const response = await instance.fetch(new Request("http://job/run", init));
  return withBodyLimit(response, job.maxResponseBytes);
}

/** The name of the instance of one job for one run. No two runs share an instance. */
export function instanceName(jobName: UtilityJobName, runId: string): string {
  return `${jobName}:${runId.toLowerCase()}`;
}

function passedHeaders(headers: Headers): Headers {
  const passed = new Headers();
  for (const name of PASSED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) passed.set(name, value);
  }
  return passed;
}

/** The response, with a body that fails once it passes `maxBytes`. */
function withBodyLimit(response: Response, maxBytes: number): Response {
  if (!response.body) return response;
  let receivedBytes = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        controller.error(new Error(`The job response is larger than ${maxBytes} bytes.`));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(limited, { status: response.status, headers: response.headers });
}

function status(code: number): Response {
  return new Response(null, { status: code });
}
