import { describe, expect, it, vi } from "vitest";

// workerd sets `env` on a WorkerEntrypoint; this stand-in does the same.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const { oauthApiFromEnv } = await import("../../../src/services/oauth/authorization-server");
const { AuthorizeHandler } = await import("../../../src/services/oauth/authorize-handler");
const { ConsentService } = await import("../../../src/services/oauth/consent-service");
const { GrantsService } = await import("../../../src/services/oauth/grants-service");
const { noAgentActivity } = await import("../../../src/services/oauth/agent-activity-lookup");
const { KvPendingConsentStore } = await import("../../../src/services/oauth/pending-consent-store");
const { serveOAuthProviderRequest } = await import("../../../src/services/oauth/provider-dispatch");
const { OAuthTokenValidator } = await import("../../../src/services/oauth/token-validator");
const { createMemoryKv } = await import("./memory-kv");
const { ISSUER, MCP_RESOURCE, OWNER, PROJECT_A, agentTokenDeps, ownerPolicy } = await import("./fixtures");

const REDIRECT_URI = "http://127.0.0.1:9999/callback";
const WEB_ORIGIN = "https://doxa.test";
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

function setup() {
  const env = { OAUTH_KV: createMemoryKv().kv, OAUTH_ISSUER: ISSUER, MCP_RESOURCE_URL: MCP_RESOURCE };
  const oauth = oauthApiFromEnv(env);
  const consents = new KvPendingConsentStore(env.OAUTH_KV);
  return {
    env,
    provider: (path: string, init: RequestInit) =>
      serveOAuthProviderRequest(new Request(`${ISSUER}${path}`, init), env, executionContext),
    authorize: new AuthorizeHandler({
      oauth,
      consents,
      now: () => new Date(),
      newConsentId: () => "f".repeat(43),
    }),
    consent: new ConsentService({
      consents,
      oauth,
      projects: ownerPolicy(),
      now: () => new Date(),
      newGrantRef: () => crypto.randomUUID(),
    }),
    grants: new GrantsService({ oauth, activity: noAgentActivity, ...agentTokenDeps }),
  };
}

async function pkce() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) throw new Error("Expected a JSON object.");
  return Object.fromEntries(Object.entries(body));
}

describe("OAuth flow against the real provider", () => {
  it("registers, consents, issues a token, lists the grant, and revokes it", async () => {
    const flow = setup();

    const registration = await json(
      await flow.provider("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Flow Agent",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
    );
    const clientId = String(registration.client_id);
    const { verifier, challenge } = await pkce();

    const authorizeUrl = new URL(`${ISSUER}/oauth/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "docs:read docs:write offline_access",
      state: "st-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_RESOURCE,
    })) {
      authorizeUrl.searchParams.set(key, value);
    }
    const parked = await flow.authorize.handle(new Request(authorizeUrl), WEB_ORIGIN);
    expect(parked.status).toBe(302);
    const consentId = new URL(parked.headers.get("location") ?? "").searchParams.get("id") ?? "";

    const details = await flow.consent.get(consentId, OWNER);
    expect(details).toMatchObject({
      kind: "found",
      details: { client: { name: "Flow Agent", verified: false }, requestedScopes: ["docs:read", "docs:write"] },
    });

    const approval = await flow.consent.approve(consentId, OWNER, {
      scopes: ["docs:read"],
      projectScope: { kind: "selected", projectIds: [PROJECT_A] },
    });
    if (approval.kind !== "approved") throw new Error(`Approval failed: ${approval.kind}`);
    const callback = new URL(approval.redirectTo);
    expect(callback.searchParams.get("state")).toBe("st-1");
    expect(callback.searchParams.get("iss")).toBe(ISSUER);

    const tokens = await json(
      await flow.provider("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.searchParams.get("code") ?? "",
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
          resource: MCP_RESOURCE,
        }),
      }),
    );
    expect(tokens.refresh_token).toEqual(expect.any(String));
    const accessToken = String(tokens.access_token);

    const validator = new OAuthTokenValidator(executionContext, flow.env);
    const validated = await validator.validateToken(MCP_RESOURCE, accessToken);
    expect(validated).toMatchObject({
      userId: OWNER,
      clientId,
      audience: MCP_RESOURCE,
      scope: ["docs:read", "offline_access"],
      props: {
        version: 1,
        userId: OWNER,
        clientName: "Flow Agent",
        projectScope: { kind: "selected", projectIds: [PROJECT_A] },
      },
    });

    const [grant] = await flow.grants.list(OWNER);
    expect(grant).toMatchObject({
      clientName: "Flow Agent",
      scopes: ["docs:read"],
      projectScope: { kind: "selected", projectIds: [PROJECT_A] },
      lastActivityAt: null,
      expiresAt: null,
    });
    expect(await flow.grants.list("someone-else")).toEqual([]);
    expect(await flow.grants.revoke("someone-else", grant.grantId)).toEqual({ kind: "not_found" });

    expect(await flow.grants.revoke(OWNER, grant.grantId)).toEqual({ kind: "revoked" });
    expect(await validator.validateToken(MCP_RESOURCE, accessToken)).toBeNull();
    expect(await flow.grants.list(OWNER)).toEqual([]);
  });

  it("returns the access_denied redirect on deny, and the consent cannot be approved after", async () => {
    const flow = setup();
    const registration = await json(
      await flow.provider("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
      }),
    );
    const { challenge } = await pkce();
    const authorizeUrl = new URL(`${ISSUER}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: String(registration.client_id),
      redirect_uri: REDIRECT_URI,
      state: "st-2",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const parked = await flow.authorize.handle(new Request(authorizeUrl), WEB_ORIGIN);
    const consentId = new URL(parked.headers.get("location") ?? "").searchParams.get("id") ?? "";

    const denial = await flow.consent.deny(consentId);
    if (denial.kind !== "denied") throw new Error("Deny failed.");
    const callback = new URL(denial.redirectTo);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("st-2");
    expect(callback.searchParams.get("iss")).toBe(ISSUER);

    expect(
      await flow.consent.approve(consentId, OWNER, {
        scopes: ["docs:read"],
        projectScope: { kind: "all" },
      }),
    ).toEqual({ kind: "not_found" });
  });
});
