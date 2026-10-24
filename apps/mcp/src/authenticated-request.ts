import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { agentGrantPropsSchema } from "@doxahq/contracts/agent-access";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  type CreateMcpHandlerOptions,
} from "agents/mcp/server";
import { agentActor, type AgentActor } from "@doxahq/api/services/agent-access/actor";
import type { McpEnv } from "./mcp-env";
import type { McpRequestContext } from "./request-context";
import { boundRequestBody, payloadTooLargeResponse } from "./request-body";
import { releaseAfterBody } from "./response-lifetime";
import { createDoxaMcpServer } from "./server";

/** The part of `OAuthResourceContext` this handler reads. */
export interface AuthenticatedRequestContext {
  readonly props: unknown;
  readonly auth: OAuthResourceAuth;
  waitUntil(promise: Promise<unknown>): void;
}

export interface OpenedRequestContext {
  readonly context: McpRequestContext;
  /** Ends the request's database pool. */
  close(): Promise<void>;
}

export interface McpRuntime {
  openContext(
    env: McpEnv,
    actor: AgentActor,
    waitUntil: (promise: Promise<unknown>) => void,
  ): OpenedRequestContext;
}

/**
 * Spec 9.1: props, actor, body limit, context, MCP handler. The SDK checks
 * each tool's scope on the parsed request (spec v2 §9, `scope-challenge.ts`).
 */
export async function handleAuthenticatedMcpRequest(
  request: Request,
  env: McpEnv,
  ctx: AuthenticatedRequestContext,
  runtime: McpRuntime,
): Promise<Response> {
  const props = agentGrantPropsSchema.safeParse(ctx.props);
  if (!props.success) return invalidTokenResponse(env.MCP_RESOURCE_URL);
  const actor = agentActor({
    userId: props.data.userId,
    clientId: ctx.auth.clientId ?? "unknown",
    clientName: props.data.clientName,
    grantRef: props.data.grantRef,
    scopes: ctx.auth.scope,
    projectScope: props.data.projectScope,
  });
  const bounded = await boundRequestBody(request);
  if (bounded.kind === "too_large") return payloadTooLargeResponse();
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
  const opened = runtime.openContext(env, actor, waitUntil);
  return serveMcp(bounded.request, env, ctx.auth, opened, waitUntil);
}

async function serveMcp(
  request: Request,
  env: McpEnv,
  auth: OAuthResourceAuth,
  opened: OpenedRequestContext,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  try {
    const handler = createMcpHandler(
      ({ era }) => createDoxaMcpServer(opened.context, era),
      mcpHandlerOptions(env.MCP_RESOURCE_URL),
    );
    const response = await handler.fetch(request, {
      authInfo: authInfoFrom(auth, env.MCP_RESOURCE_URL),
    });
    return releaseAfterBody(response, () => opened.close(), waitUntil);
  } catch (error) {
    waitUntil(opened.close());
    throw error;
  }
}

export function mcpHandlerOptions(
  resourceUrl: string,
): CreateMcpHandlerOptions {
  const { hostname, pathname } = new URL(resourceUrl);
  return {
    route: pathname,
    legacy: "stateless",
    allowedHostnames: [hostname],
    allowedOriginHostnames: [hostname],
  };
}

// Never returned to a client; tools receive it through the SDK context only.
// The SDK's scope challenge advertises `resourceMetadataUrl`.
function authInfoFrom(auth: OAuthResourceAuth, resourceUrl: string): AuthInfo {
  return {
    token: auth.token,
    clientId: auth.clientId ?? "unknown",
    scopes: auth.scope,
    expiresAt: auth.expiresAt,
    resource: new URL(auth.audience),
    resourceMetadataUrl: resourceMetadataUrlFor(resourceUrl),
  };
}

/** RFC 9728: the metadata document of the resource at `resourceUrl`. */
function resourceMetadataUrlFor(resourceUrl: string): string {
  const { origin, pathname } = new URL(resourceUrl);
  return `${origin}/.well-known/oauth-protected-resource${pathname}`;
}

/** Grant props that fail the schema make the token invalid (spec 6.4). */
function invalidTokenResponse(resourceUrl: string): Response {
  const metadataUrl = resourceMetadataUrlFor(resourceUrl);
  return Response.json(
    {
      error: "invalid_token",
      error_description: "The token is not valid for Doxa.",
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="The token is not valid for Doxa."`,
      },
    },
  );
}
