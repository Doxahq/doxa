import type { PrerenderIdentity } from "@doxahq/contracts/docs-prerender";

import type { BuildRejection } from "./versioned-entrypoint-protocol";

/**
 * The log line for a rejected renderer release (F14).
 *
 * `DocsRouteDataCache` and `DocsPrerenderCache` key their entries on the
 * delivery identity, which contains the renderer release. A call that names
 * another release than the deployed one would render with the deployed build
 * and store the result under the other release's key, so the entrypoint
 * protocol rejects it (`rejectedBuild`). This line makes such a call visible.
 */
export function logRendererReleaseRejected(input: {
  entrypoint: "DocsRouteDataCache" | "DocsPrerenderCache";
  expected: PrerenderIdentity;
  deployedReleaseId: string | undefined;
  reason: BuildRejection;
}): void {
  console.warn(
    JSON.stringify({
      event: "docs_cache_release_rejected",
      entrypoint: input.entrypoint,
      reason: `release_${input.reason}`,
      siteId: input.expected.siteId,
      requestedReleaseId: input.expected.rendererReleaseId,
      deployedReleaseId: input.deployedReleaseId?.trim() || null,
    }),
  );
}
