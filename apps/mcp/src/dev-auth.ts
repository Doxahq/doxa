import {
  isOAuthScope,
  OAUTH_SCOPES,
  type AgentGrantProps,
} from "@doxahq/contracts/agent-access";
import type { AuthenticatedRequestContext } from "./authenticated-request";
import type { McpEnv } from "./mcp-env";

export const DEV_USER_HEADER = "x-doxa-dev-user-id";
export const DEV_SCOPES_HEADER = "x-doxa-dev-scopes";

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);
const DEV_GRANT_REF = "00000000-0000-4000-8000-000000000000";

/**
 * Local development before real tokens exist: a fake auth context from a
 * header. It needs the env flag, a localhost request, and the header. The
 * production config sets MCP_DEV_AUTH_BYPASS to "false", and
 * validate:production-config rejects any other value there.
 */
export function devAuthContext(
  request: Request,
  env: McpEnv,
  waitUntil: (promise: Promise<unknown>) => void,
): AuthenticatedRequestContext | null {
  if (env.MCP_DEV_AUTH_BYPASS !== "true") return null;
  if (!LOCAL_HOSTNAMES.has(new URL(request.url).hostname)) return null;
  const userId = request.headers.get(DEV_USER_HEADER)?.trim();
  if (!userId) return null;
  const props: AgentGrantProps = {
    version: 1,
    grantRef: DEV_GRANT_REF,
    userId,
    clientName: "Local development",
    projectScope: { kind: "all" },
  };
  return {
    props,
    auth: {
      token: "local-dev-bypass",
      audience: env.MCP_RESOURCE_URL,
      scope: devScopes(request.headers.get(DEV_SCOPES_HEADER)),
      userId,
      clientId: "local-dev",
    },
    waitUntil,
  };
}

function devScopes(header: string | null): string[] {
  if (header === null) return [...OAUTH_SCOPES];
  return header.split(/\s+/).filter(isOAuthScope);
}
