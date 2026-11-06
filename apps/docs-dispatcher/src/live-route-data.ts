import type { DocsDomainResolution } from "@doxahq/contracts";
import { parsePublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";

import { toHostResolution } from "./host-resolution";
import type { PrerenderRendererRpc } from "./worker-exports";

/**
 * Prepares route data live through the pinned renderer. The caller decides
 * whether the result may be stored. A failure is an HTTP 503, never a throw,
 * so every caller handles it as a normal uncacheable response.
 */
export async function createLiveRouteDataResponse(
  renderer: Pick<PrerenderRendererRpc, "prepare">,
  resolution: DocsDomainResolution,
  pathname: string,
  warn: (message: string) => void = console.warn,
): Promise<Response> {
  try {
    const routeData = parsePublicDocsRouteDataV1(
      await renderer.prepare({
        resolution: toHostResolution(resolution),
        pathname,
      }),
    );
    return Response.json(routeData, {
      headers: {
        "x-content-type-options": "nosniff",
        "x-doxa-representation-source": "dynamic",
      },
    });
  } catch (error) {
    warn(
      `[doxa-docs-dispatcher] Live route data failed for site ${resolution.siteId} path ${JSON.stringify(pathname)}: ${describeError(error)}`,
    );
    return new Response("Live route data unavailable", { status: 503 });
  }
}

/** A Zod error message lists every issue, so the log keeps only its start. */
const MAX_ERROR_LENGTH = 500;

function describeError(error: unknown): string {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
  return text.length > MAX_ERROR_LENGTH
    ? `${text.slice(0, MAX_ERROR_LENGTH)}…`
    : text;
}
