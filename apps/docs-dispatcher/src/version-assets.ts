import type { DocsHostResolution } from "@doxahq/contracts";
import {
  docsAssetNameFromUrlPath,
  docsAssetVersionFromUrl,
} from "@doxahq/contracts/docs-assets";

interface VersionAssetDependencies {
  resolveHost(hostname: string): Promise<DocsHostResolution | null>;
  runtime: {
    versionAsset?(input: {
      resolution: DocsHostResolution;
      name: string;
      version?: string | null;
    }): Promise<Response>;
  };
}

/**
 * Serves `/assets/{name}`: an image of the published version of a public
 * site. Returns null for every other request, for a private site (the
 * renderer runs its access gate first), and for a miss, so a renderer file
 * of the same shape still reaches the renderer.
 */
export async function handleVersionAssetRequest(
  request: Request,
  dependencies: VersionAssetDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  const name = docsAssetNameFromUrlPath(url.pathname);
  if (!name || (request.method !== "GET" && request.method !== "HEAD"))
    return null;
  const resolution = await dependencies.resolveHost(url.hostname);
  if (
    resolution?.accessPolicy !== "public" ||
    !dependencies.runtime.versionAsset
  )
    return null;
  const version = docsAssetVersionFromUrl(url);
  const response = await dependencies.runtime.versionAsset({
    resolution,
    name,
    ...(version ? { version } : {}),
  });
  if (response.status === 404) return null;
  return request.method === "HEAD" ? new Response(null, response) : response;
}
