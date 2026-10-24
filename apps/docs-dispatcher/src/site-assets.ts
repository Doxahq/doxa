import type { DocsHostResolution } from "@doxahq/contracts";
import { sha256Schema } from "@doxahq/contracts/docs-prerender";

interface SiteAssetDependencies {
  resolveHost(hostname: string): Promise<DocsHostResolution | null>;
  runtime: {
    asset?(input: {
      resolution: DocsHostResolution;
      hash: string;
    }): Promise<Response>;
  };
  privateRenderer: Pick<Fetcher, "fetch">;
}

export async function handleSiteAssetRequest(
  request: Request,
  dependencies: SiteAssetDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  const prefix = "/_doxa/assets/";
  if (!url.pathname.startsWith(prefix)) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return unavailable(405);
  const hash = sha256Schema.safeParse(url.pathname.slice(prefix.length));
  if (!hash.success) return unavailable(404);
  const resolution = await dependencies.resolveHost(url.hostname);
  if (!resolution) return unavailable(404);
  // Private assets pass through the same access gate as private documentation.
  if (resolution.accessPolicy !== "public")
    return dependencies.privateRenderer.fetch(request);
  if (!dependencies.runtime.asset) return unavailable(503);
  const response = await dependencies.runtime.asset({
    resolution,
    hash: hash.data,
  });
  return request.method === "HEAD" ? new Response(null, response) : response;
}

function unavailable(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
