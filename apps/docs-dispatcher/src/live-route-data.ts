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
  } catch {
    return new Response("Live route data unavailable", { status: 503 });
  }
}
