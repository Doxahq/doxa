import { normalizePublicDocsPathname } from "@doxahq/contracts/docs-prerender";

import {
  getEnabledPrerenderMode,
  resolveActiveDelivery,
  type DeliveryRequestContext,
} from "./delivery-identity";
import {
  mergeFreshInternalServerTiming,
  type ServerTimingRecorder,
} from "./server-timing";
import { getWorkerExports } from "./worker-exports";

export interface PrerenderAttemptDiagnostics {
  cacheStatus: string;
  lookupReason: string | null;
  lookupStatus: string | null;
}

export interface SavedHtmlAttempt {
  diagnostics: PrerenderAttemptDiagnostics | null;
  eligible: boolean;
  response: Response | null;
}

const NOT_ELIGIBLE: SavedHtmlAttempt = {
  diagnostics: null,
  eligible: false,
  response: null,
};

export async function tryPrerenderedHtml(
  input: DeliveryRequestContext,
): Promise<SavedHtmlAttempt> {
  const featureMode = getEnabledPrerenderMode(input.rollouts);
  if (!featureMode) return NOT_ELIGIBLE;
  const url = new URL(input.request.url);
  const resolution = await input.resolveHost(url.hostname);
  const active = await resolveActiveDelivery(
    input.request,
    resolution,
    input.env,
    input.rollouts,
  );
  if (
    !resolution ||
    active?.delivery !== "saved" ||
    !input.env.DOCS_RENDERED_BUCKET
  ) {
    return NOT_ELIGIBLE;
  }
  let pathname: string;
  try {
    pathname = normalizePublicDocsPathname(url.pathname);
  } catch {
    return NOT_ELIGIBLE;
  }
  let cacheStatus = "BYPASS";
  const response = await input.timing.measure(
    "doxa_prerender_cache",
    async () => {
      const result = await getWorkerExports(input.ctx)
        .DocsPrerenderCache({
          props: {
            expected: active.identity,
            featureMode,
            hostname: url.hostname,
            pathname,
            representation: "html",
            resolution,
          },
        })
        .fetch(
          new Request(input.request.url, {
            method: "GET",
            headers: { accept: "text/html" },
          }),
        );
      cacheStatus = result.headers.get("cf-cache-status") ?? "BYPASS";
      return result;
    },
    () => cacheStatus,
  );
  mergeFreshInternalServerTiming(input.timing, response, cacheStatus);
  const diagnostics = readPrerenderDiagnostics(response, cacheStatus);
  if (response.status === 404) {
    return { diagnostics, eligible: true, response: null };
  }
  if (input.request.method === "HEAD") {
    return {
      diagnostics,
      eligible: true,
      response: new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }
  return { diagnostics, eligible: true, response };
}

export function readPrerenderDiagnostics(
  response: Response,
  cacheStatus: string,
): PrerenderAttemptDiagnostics {
  return {
    cacheStatus,
    lookupReason: response.headers.get("x-doxa-prerender-reason"),
    lookupStatus: response.headers.get("x-doxa-prerender-lookup"),
  };
}

export function applyPrerenderDiagnostics(
  response: Response,
  diagnostics: PrerenderAttemptDiagnostics,
  timing: ServerTimingRecorder,
): void {
  if (!timing.enabled) return;
  response.headers.set("x-doxa-prerender-cache", diagnostics.cacheStatus);
  if (diagnostics.lookupStatus) {
    response.headers.set("x-doxa-prerender-lookup", diagnostics.lookupStatus);
  }
  if (diagnostics.lookupReason) {
    response.headers.set("x-doxa-prerender-reason", diagnostics.lookupReason);
  }
}
