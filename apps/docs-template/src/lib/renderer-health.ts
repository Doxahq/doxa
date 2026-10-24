// Keep this path and header in sync with apps/api/src/services/docs-domain-routing.ts.
// The renderer does not import platform packages, so this small protocol is duplicated.
const RENDERER_HEALTH_PATH = "/.well-known/doxa-health";
const RENDERER_HEALTH_HEADER = "x-doxa-renderer-health";

export function getRendererHealthResponse(request: Request): Response | null {
  if (new URL(request.url).pathname !== RENDERER_HEALTH_PATH) return null;

  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-store",
      [RENDERER_HEALTH_HEADER]: "ok",
    },
  });
}
