import type { DocsHostResolution } from "@doxahq/contracts";
import {
  readDocsRuntimeCallTiming,
  type DocsRuntimeCallTiming,
  type DocsRuntimeCaller,
  type DocsRuntimeTrace,
} from "@doxahq/contracts/docs-runtime-trace";

import type { DocsRuntimeRpc, RuntimeResponse } from "./worker-exports";

/**
 * Traces of dispatcher → docs-runtime calls (M39). The dispatcher makes each
 * trace ID itself. It never copies a trace from renderer input, so a renderer
 * cannot pick the ID that docs-runtime logs.
 */
export function createRuntimeTrace(
  caller: DocsRuntimeCaller,
  createId: () => string = () => crypto.randomUUID(),
): DocsRuntimeTrace {
  return { id: createId(), caller };
}

/** A runtime answer split into the renderer's part and docs-runtime's timing. */
export interface TracedRuntimeResponse {
  response: RuntimeResponse;
  timing: DocsRuntimeCallTiming | undefined;
}

/**
 * Removes `timing` from a runtime answer. The renderer keeps its old
 * contract (`ok` and `data` or `error`) and never sees docs-runtime facts.
 * An invalid timing is dropped too.
 */
export function splitRuntimeTiming(
  response: RuntimeResponse,
): TracedRuntimeResponse {
  if (!("timing" in response)) return { response, timing: undefined };
  return {
    response: response.ok
      ? { ok: true, data: response.data }
      : { ok: false, error: response.error },
    timing: readDocsRuntimeCallTiming(response.timing),
  };
}

/** Sends one traced call to docs-runtime and returns the renderer's part of the answer. */
export async function requestDocsRuntime(
  runtime: Pick<DocsRuntimeRpc, "request">,
  input: {
    resolution: DocsHostResolution;
    operation: string;
    payload?: unknown;
  },
  caller: DocsRuntimeCaller,
): Promise<RuntimeResponse> {
  const answer = await runtime.request({
    resolution: input.resolution,
    operation: input.operation,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    trace: createRuntimeTrace(caller),
  });
  return splitRuntimeTiming(answer).response;
}
