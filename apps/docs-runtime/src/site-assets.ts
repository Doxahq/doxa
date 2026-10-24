import { docsHostResolutionSchema } from "@doxahq/contracts";
import { sha256Schema } from "@doxahq/contracts/docs-prerender";
import { siteConfigSchema, siteConfigAssetRefs } from "@doxahq/site-config";
import {
  authenticateRuntimeRequest,
  getRuntimeScope,
  resolveDocsHost,
  resolveDocsProject,
  runResolvedRuntimeRequest,
  type RuntimeSourceEnv,
} from "./runtime-source";

export async function handleSiteAssetRequest(
  request: Request,
  env: RuntimeSourceEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/runtime-source/assets/")) return null;
  const authError = await authenticateRuntimeRequest(request, env);
  if (authError) return authError;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  const scope = getRuntimeScope(request);
  if (!scope) return missing();
  const resolution = await (scope.kind === "host"
    ? resolveDocsHost(env, scope.value)
    : resolveDocsProject(env, scope.value));
  const response = await serveSiteAsset(
    env,
    resolution,
    path.slice("/runtime-source/assets/".length),
  );
  return request.method === "HEAD" ? new Response(null, response) : response;
}

const ASSET_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
]);

/** The caller is the trusted dispatcher binding, never a browser-supplied resolution. */
export async function serveSiteAsset(
  env: RuntimeSourceEnv,
  resolutionInput: unknown,
  hashInput: unknown,
): Promise<Response> {
  const resolution = docsHostResolutionSchema.safeParse(resolutionInput);
  const hash = sha256Schema.safeParse(hashInput);
  if (!resolution.success || !hash.success) return missing();
  const result = await runResolvedRuntimeRequest(env, {
    resolution: resolution.data,
    operation: "getResolvedSiteConfig",
  });
  if (!result.ok) return missing();
  const config = siteConfigSchema.safeParse(result.data);
  if (
    !config.success ||
    !siteConfigAssetRefs(config.data).some(
      (ref) => ref === `asset:${hash.data}`,
    )
  )
    return missing();
  const object = await env.DOCS_BUCKET.get(
    `sites/${resolution.data.siteId}/assets/${hash.data}`,
  );
  const contentType = object?.httpMetadata?.contentType;
  if (!object || !contentType || !ASSET_CONTENT_TYPES.has(contentType))
    return missing();
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control":
      resolution.data.accessPolicy === "public"
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType === "image/svg+xml")
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  return new Response(object.body, { headers });
}

function missing(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}
