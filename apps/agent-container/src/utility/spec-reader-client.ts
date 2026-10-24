import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpecReaderCallResult, SpecReaderClient } from "@doxahq/agent";
import { SPEC_READER_JOB, type SpecReaderInput } from "@doxahq/contracts/spec-reader";
import { parseJobOutcome, runJobChild, type JobOutcome } from "@doxahq/utility-kit";
import { JOB_RUN_PATH } from "@doxahq/utility-kit/supervisor";
import { LocalJobContainer } from "./docker-job";
import { RUN_ID_HEADER } from "./gate";
import { UTILITY_HOST } from "./registry";

/**
 * `container` (the default) calls the job in its own container through the
 * gate. `docker` runs the job image on local Docker, one container for
 * each run, for development. `local` runs the built job bundle as a local
 * child process, for tests and machines without Docker. `off` sends every
 * REST reference to the model.
 */
export type UtilityMode = "container" | "docker" | "local" | "off";

/** The tag that `pnpm --filter @doxahq/job-spec-reader image` builds. */
export const LOCAL_SPEC_READER_IMAGE = "doxa-spec-reader:dev";

/** The job bundle that `pnpm --filter @doxahq/job-spec-reader bundle` builds in a checkout. */
const LOCAL_SPEC_READER_BUNDLE = fileURLToPath(
  new URL("../../../utility-jobs/spec-reader/dist/job.mjs", import.meta.url),
);

/** Room for the gate and the network above the time limit of the job call itself. */
const CALL_TIMEOUT_MARGIN_MS = 5_000;

/**
 * The spec-reader client of one run. Undefined when the mode is `off`, or
 * when the local bundle was not built. The production image does not hold
 * the job bundle, so `local` cannot run there.
 */
export function resolveSpecReaderClient(
  runId: string,
  env: Record<string, string | undefined> = process.env,
): SpecReaderClient | undefined {
  switch (resolveUtilityMode(env.DOXA_UTILITY_MODE)) {
    case "off":
      return undefined;
    case "local": {
      const bundle = env.DOXA_SPEC_READER_BUNDLE?.trim() || LOCAL_SPEC_READER_BUNDLE;
      return existsSync(bundle) ? createLocalSpecReaderClient(bundle) : undefined;
    }
    case "docker":
      return createDockerSpecReaderClient(new LocalJobContainer({
        job: SPEC_READER_JOB.name,
        image: env.DOXA_SPEC_READER_IMAGE?.trim() || LOCAL_SPEC_READER_IMAGE,
        port: SPEC_READER_JOB.port,
        runId,
      }));
    case "container":
      return createGateSpecReaderClient(runId);
  }
}

export function resolveUtilityMode(value: string | undefined): UtilityMode {
  const mode = value?.trim();
  return mode === "docker" || mode === "local" || mode === "off" ? mode : "container";
}

/** Calls the job in its own container, through the gate of the agent container. */
export function createGateSpecReaderClient(
  runId: string,
  fetchImpl: typeof fetch = fetch,
): SpecReaderClient {
  const url = (action: "run" | "done") => `http://${UTILITY_HOST}/v1/jobs/${SPEC_READER_JOB.name}/${action}`;
  return {
    read: (input) => postJobCall(fetchImpl, url("run"), input, { [RUN_ID_HEADER]: runId }, "gate"),
    async done() {
      await fetchImpl(url("done"), { method: "POST", headers: { [RUN_ID_HEADER]: runId } });
    },
  };
}

/**
 * Calls the job in a container of local Docker, which starts on the first
 * call of the run and is removed by `done`, as the gate does in production.
 */
export function createDockerSpecReaderClient(
  container: LocalJobContainer,
  fetchImpl: typeof fetch = fetch,
): SpecReaderClient {
  return {
    async read(input) {
      let baseUrl: string;
      try {
        baseUrl = await container.baseUrl();
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Docker failed.";
        return { ok: false, code: "docker_unavailable", message: `The local job container did not start: ${reason}` };
      }
      return postJobCall(fetchImpl, `${baseUrl}${JOB_RUN_PATH}`, input, {}, "job");
    },
    done: () => container.stop(),
  };
}

/** Posts one job call and reads its outcome. The supervisor answers an oversized input with 413 and an outcome. */
async function postJobCall(
  fetchImpl: typeof fetch,
  url: string,
  input: SpecReaderInput,
  headers: Record<string, string>,
  answeredBy: "gate" | "job",
): Promise<SpecReaderCallResult> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(SPEC_READER_JOB.callTimeoutMs + CALL_TIMEOUT_MARGIN_MS),
  });
  if (!response.ok && response.status !== 413) {
    return { ok: false, code: `${answeredBy}_${response.status}`, message: `The ${answeredBy} answered ${response.status}.` };
  }
  return toCallResult(parseJobOutcome(await response.text()));
}

/** Runs the job bundle as a local child, with the same flags as in its container. */
export function createLocalSpecReaderClient(bundle: string): SpecReaderClient {
  return {
    async read(input) {
      return toCallResult(await runJobChild({
        entry: bundle,
        readDirectory: dirname(bundle),
        heapMb: SPEC_READER_JOB.heapMb,
        timeoutMs: SPEC_READER_JOB.childTimeoutMs,
        maxOutputBytes: SPEC_READER_JOB.maxOutputBytes,
        input: new TextEncoder().encode(JSON.stringify(input)),
      }));
    },
    async done() {},
  };
}

function toCallResult(outcome: JobOutcome<unknown>): SpecReaderCallResult {
  return outcome.ok
    ? { ok: true, output: outcome.output }
    : { ok: false, code: outcome.error.code, message: outcome.error.message };
}
