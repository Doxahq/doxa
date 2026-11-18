import { OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { clientIpRateLimitKey } from "@doxahq/contracts/client-ip";
import {
  handleAuthenticatedMcpRequest,
  type McpRuntime,
} from "./authenticated-request";
import { handleAssetUpload, isAssetUploadPath } from "./asset-upload-endpoint";
import { devAuthContext } from "./dev-auth";
import type { McpEnv } from "./mcp-env";
import { openProductionContext } from "./production-context";

const RUNTIME: McpRuntime = { openContext: openProductionContext };

let cached:
  | { key: string; server: OAuthResourceServer<McpEnv, unknown> }
  | undefined;

// The provider checks its options in the constructor, so it cannot take a
// function of the env. Build it on the first request, keyed on the env values.
function resourceServerFor(env: McpEnv): OAuthResourceServer<McpEnv, unknown> {
  const key = `${env.OAUTH_ISSUER}|${env.MCP_RESOURCE_URL}`;
  if (cached?.key === key) return cached.server;
  const server = new OAuthResourceServer<McpEnv, unknown>({
    resourceMetadata: {
      resource: env.MCP_RESOURCE_URL,
      authorization_servers: [env.OAUTH_ISSUER],
      resource_name: "Doxa",
    },
    validateToken: (bindings) => bindings.AUTH_SERVER.validateToken,
    handler: {
      fetch: (request, bindings, ctx) =>
        handleAuthenticatedMcpRequest(request, bindings, ctx, RUNTIME),
    },
  });
  cached = { key, server };
  return server;
}

/** A 429 response when the client IP is over its limit, else null. */
async function limitByIp(request: Request, env: McpEnv): Promise<Response | null> {
  const clientIp = request.headers.get("cf-connecting-ip");
  if (!env.MCP_IP_LIMITER || !clientIp) return null;
  const { success } = await env.MCP_IP_LIMITER.limit({ key: clientIpRateLimitKey(clientIp) });
  if (success) return null;
  return Response.json(
    { error: "rate_limited", error_description: "Too many requests. Try again in a minute." },
    { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } },
  );
}

/** For uptime monitors. It reaches no dependency, so it costs nothing. */
const HEALTH_PATH = "/health";

export default {
  async fetch(request, env, ctx) {
    const limited = await limitByIp(request, env);
    if (limited) return limited;
    const { pathname } = new URL(request.url);
    if (pathname === HEALTH_PATH && request.method === "GET") {
      return Response.json(
        { ok: true, service: "doxa-mcp" },
        { headers: { "cache-control": "no-store" } },
      );
    }
    // The upload URL carries its own secret, so it needs no bearer token.
    if (isAssetUploadPath(pathname)) {
      return handleAssetUpload(request, env);
    }
    const devContext = devAuthContext(request, env, (promise) =>
      ctx.waitUntil(promise),
    );
    if (devContext) {
      return handleAuthenticatedMcpRequest(request, env, devContext, RUNTIME);
    }
    return resourceServerFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<McpEnv>;
