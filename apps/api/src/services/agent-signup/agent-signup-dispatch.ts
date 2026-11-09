import {
  AGENT_CLAIM_GRANT_TYPE,
  AGENT_IDENTITY_TYPE,
  agentIdentityRequestSchema,
} from "@doxahq/contracts/agent-access";
import { clientIpRateLimitKey } from "@doxahq/contracts/client-ip";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../../env";
import { getWebOrigin } from "../../http/access";
import type { ApiBindings } from "../../http/app";
import { RequestBodyTooLarge, limitRequestBody } from "../../http/bounded-body";
import { AgentTokenRepository } from "../../repositories/agent-tokens";
import { METADATA_PATH } from "../oauth/authorization-server";
import { AgentClaimService, type AgentClaimPoll, type AgentRegistration } from "./agent-claim-service";
import {
  isAgentSignupEnabled,
  isAgentSignupUnavailable,
  requireAgentSignupConfig,
} from "./agent-signup-config";
import { isAgentToken, sha256Hex } from "./agent-signup-secrets";

const IDENTITY_PATH = "/agent/identity";
const TOKEN_PATH = "/oauth/token";
const AGENT_REQUEST_MAX_BYTES = 16 * 1024;

type ApiContext = Context<ApiBindings>;

/** How the dispatch gets its services; tests pass fakes. */
export interface AgentSignupServices {
  claims(env: Env): Pick<AgentClaimService, "register" | "poll">;
  revokeToken(env: Env, tokenHash: string): Promise<void>;
}

const servicesFromEnv: AgentSignupServices = {
  claims: (env) => AgentClaimService.fromEnv(env),
  revokeToken: (env, tokenHash) => new AgentTokenRepository(env).revokeByHash(tokenHash, new Date()),
};

/**
 * Runs before the OAuth provider and adds the auth.md claim flow to it. Agents
 * send no cookies, so these paths skip the browser CORS and CSRF rules.
 */
export function agentSignupDispatch(
  services: AgentSignupServices = servicesFromEnv,
): MiddlewareHandler<ApiBindings> {
  return async (context, next) => {
    // The undecoded path, as the edge sees it, so that `/agent/%69dentity` cannot avoid the edge limit.
    const path = new URL(context.req.url).pathname.replace(/\/+$/, "");
    if (path === IDENTITY_PATH) return handleIdentity(context, services);
    if (path === TOKEN_PATH && context.req.method === "POST") {
      const response = await handleTokenRequest(context, services);
      return response ?? next();
    }
    if (path === METADATA_PATH && context.req.method === "GET" && isAgentSignupEnabled(context.env)) {
      await next();
      context.res = await withAgentAuthMetadata(context, context.res);
      return;
    }
    return next();
  };
}

async function handleIdentity(context: ApiContext, services: AgentSignupServices): Promise<Response> {
  if (context.req.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  }
  const text = await readBody(context.req.raw);
  if (text === null) return protocolError("invalid_request", "The request body is too large.", 413);
  const body = parseJsonBody(text);
  if (isUnsupportedIdentityType(body)) {
    return protocolError("unsupported_identity_type", `Only ${AGENT_IDENTITY_TYPE} is supported.`, 400);
  }
  const request = agentIdentityRequestSchema.safeParse(body);
  if (!request.success) return protocolError("invalid_request", "The request body is not valid.", 400);

  return whenAvailable(async () => {
    const clientIp = context.req.header("cf-connecting-ip");
    const registration = await services.claims(context.env).register(request.data, {
      clientIpKey: clientIp ? clientIpRateLimitKey(clientIp) : null,
      webOrigin: getWebOrigin(context.req.raw, context.env),
    });
    return registrationResponse(registration);
  });
}

/** Null when the request is for the OAuth provider. */
async function handleTokenRequest(
  context: ApiContext,
  services: AgentSignupServices,
): Promise<Response | null> {
  const raw = context.req.raw;
  if (!raw.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) return null;
  const text = await readBody(raw);
  if (text === null) return protocolError("invalid_request", "The request body is too large.", 413);
  // The body is read once. The provider gets a new request with the same bytes.
  context.req.raw = new Request(raw, { body: text });
  const form = new URLSearchParams(text);
  if (form.get("grant_type") === AGENT_CLAIM_GRANT_TYPE) {
    return whenAvailable(async () => {
      const claimToken = form.get("claim_token") ?? "";
      return pollResponse(await services.claims(context.env).poll(claimToken));
    });
  }
  const token = form.get("token");
  if (!form.has("grant_type") && token !== null && isAgentToken(token)) {
    await services.revokeToken(context.env, await sha256Hex(token));
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }
  return null;
}

function registrationResponse(registration: AgentRegistration): Response {
  if (registration.kind === "rate_limited") {
    return protocolError(
      "rate_limit_exceeded",
      "Too many registration attempts. Stop and tell the user.",
      429,
      { "retry-after": "3600" },
    );
  }
  const { grant } = registration;
  return protocolJson(
    {
      registration_id: grant.registrationId,
      registration_type: AGENT_IDENTITY_TYPE,
      claim_token: grant.claimToken,
      claim_token_expires: grant.claimTokenExpires,
      post_claim_scopes: grant.scopes,
      claim: {
        user_code: grant.userCode,
        verification_uri: grant.verificationUri,
        expires_in: grant.expiresIn,
        interval: grant.interval,
      },
    },
    200,
  );
}

function pollResponse(poll: AgentClaimPoll): Response {
  switch (poll.kind) {
    case "issued":
      return protocolJson(
        {
          access_token: poll.accessToken,
          token_type: "Bearer",
          expires_in: poll.expiresIn,
          scope: poll.scope,
          mcp_url: poll.mcpUrl,
        },
        200,
      );
    case "pending":
      return protocolError("authorization_pending", poll.stage, 400);
    case "slow_down":
      return protocolError("slow_down", "Poll less often.", 400);
    case "expired":
      return protocolError("expired_token", "The claim expired. Ask the user before you start again.", 400);
    case "denied":
      return protocolError("access_denied", "The claim was denied or locked.", 400);
    case "invalid":
      return protocolError("invalid_grant", "The claim token is not valid.", 400);
  }
}

async function withAgentAuthMetadata(context: ApiContext, response: Response): Promise<Response> {
  if (!response.ok) return response;
  const { issuer } = requireAgentSignupConfig(context.env);
  const metadata: unknown = await response.json();
  if (typeof metadata !== "object" || metadata === null) return response;
  const grants = "grant_types_supported" in metadata && Array.isArray(metadata.grant_types_supported)
    ? metadata.grant_types_supported
    : [];
  return Response.json(
    {
      ...metadata,
      grant_types_supported: [...grants, AGENT_CLAIM_GRANT_TYPE],
      agent_auth: {
        skill: `${getWebOrigin(context.req.raw, context.env)}/auth.md`,
        identity_endpoint: `${issuer}${IDENTITY_PATH}`,
        identity_types_supported: [AGENT_IDENTITY_TYPE],
      },
    },
    { status: response.status, headers: response.headers },
  );
}

async function whenAvailable(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (cause) {
    if (isAgentSignupUnavailable(cause)) {
      return protocolError("temporarily_unavailable", "Agent signup is not available.", 503);
    }
    throw cause;
  }
}

/** Null when the body is over the limit. */
async function readBody(request: Request): Promise<string | null> {
  try {
    return await limitRequestBody(request, AGENT_REQUEST_MAX_BYTES).text();
  } catch (cause) {
    if (cause instanceof RequestBodyTooLarge) return null;
    throw cause;
  }
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isUnsupportedIdentityType(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("type" in body)) return false;
  return typeof body.type === "string" && body.type !== AGENT_IDENTITY_TYPE;
}

function protocolError(
  code: string,
  description: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return protocolJson({ error: code, error_description: description }, status, headers);
}

/** These responses can hold secrets, so nothing may store them. */
function protocolJson(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", ...headers },
  });
}
