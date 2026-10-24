import { OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import {
  handleAuthenticatedMcpRequest,
  type McpRuntime,
} from "./authenticated-request";
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

export default {
  fetch(request, env, ctx) {
    const devContext = devAuthContext(request, env, (promise) =>
      ctx.waitUntil(promise),
    );
    if (devContext) {
      return handleAuthenticatedMcpRequest(request, env, devContext, RUNTIME);
    }
    return resourceServerFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<McpEnv>;
