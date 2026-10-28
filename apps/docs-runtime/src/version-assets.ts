import { docsHostResolutionSchema } from "@doxahq/contracts";
import {
  docsAssetArtifactPath,
  docsAssetContentTypeForName,
  docsAssetVersionFromUrl,
} from "@doxahq/contracts/docs-assets";
import {
  parseVersionPrefix,
  type VersionObjectFetcher,
} from "@doxahq/docs-engine";
import { artifactReader } from "./artifact-storage";
import {
  authenticateRuntimeRequest,
  getRuntimeScope,
  resolveDocsHost,
  resolveDocsProject,
  type RuntimeSourceEnv,
} from "./runtime-source";

const ROUTE_PREFIX = "/runtime-source/version-assets/";

/**
 * Images that a published version holds at `assets/{name}`. A page links to
 * one with `/assets/{name}`. They live in the version tree, unlike site
 * assets, so each version serves its own images.
 */
export async function handleVersionAssetRequest(
  request: Request,
  env: RuntimeSourceEnv,
  blobCache: VersionObjectFetcher | null = null,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(ROUTE_PREFIX)) return null;
  const authError = await authenticateRuntimeRequest(request, env);
  if (authError) return authError;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  const scope = getRuntimeScope(request);
  if (!scope) return missing();
  const resolution = await (scope.kind === "host"
    ? resolveDocsHost(env, scope.value)
    : resolveDocsProject(env, scope.value));
  // Asset names are plain slugs, so the path segment needs no decoding.
  const response = await serveVersionAsset(
    env,
    resolution,
    path.slice(ROUTE_PREFIX.length),
    docsAssetVersionFromUrl(new URL(request.url)),
    blobCache,
  );
  return request.method === "HEAD" ? new Response(null, response) : response;
}

/**
 * The caller is the trusted dispatcher binding, never a browser-supplied
 * resolution.
 *
 * `version` is the content hash from `?v=`. When it matches the file that
 * the version tree holds, the URL can only ever return these bytes, so a
 * public response is cached for a year. A hash that does not match (a page
 * of an older version) still gets the current file, with the short cache.
 */
export async function serveVersionAsset(
  env: RuntimeSourceEnv,
  resolutionInput: unknown,
  nameInput: unknown,
  version: unknown = null,
  blobCache: VersionObjectFetcher | null = null,
): Promise<Response> {
  const resolution = docsHostResolutionSchema.safeParse(resolutionInput);
  if (!resolution.success || typeof nameInput !== "string") return missing();
  const contentType = docsAssetContentTypeForName(nameInput);
  if (
    !contentType ||
    !isFolderOfSite(resolution.data.artifactPrefix, resolution.data.siteId)
  )
    return missing();
  const reader = artifactReader(env, { blobCache });
  const path = docsAssetArtifactPath(nameInput);
  const object = await reader.get(`${resolution.data.artifactPrefix}/${path}`);
  if (!object) return missing();
  const pinned =
    typeof version === "string" &&
    (await reader.readTree(resolution.data.artifactPrefix))?.files[path]
      ?.sha256 === version;
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control":
      resolution.data.accessPolicy !== "public"
        ? "private, no-store"
        : pinned
          ? "public, max-age=31536000, immutable"
          : // The same path can hold another image in a later version.
            "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType === "image/svg+xml")
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  return new Response(await object.arrayBuffer(), { headers });
}

/** Reads stay inside a version folder of the resolved site. */
function isFolderOfSite(artifactPrefix: string, siteId: string): boolean {
  try {
    return parseVersionPrefix(artifactPrefix)?.siteId === siteId;
  } catch {
    return false;
  }
}

function missing(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}
