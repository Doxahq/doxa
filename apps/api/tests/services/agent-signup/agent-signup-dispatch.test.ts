import { AGENT_CLAIM_GRANT_TYPE } from "@doxahq/contracts/agent-access";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { createApiRouter } = await import("../../../src/http/app");
const { agentSignupDispatch } = await import("../../../src/services/agent-signup/agent-signup-dispatch");
const { AgentSignupDisabledError } = await import("../../../src/services/agent-signup/agent-signup-config");
const { newAgentToken, sha256Hex } = await import("../../../src/services/agent-signup/agent-signup-secrets");

const env = {
  WEB_ORIGIN: "https://doxa.test",
  OAUTH_KV: {},
  OAUTH_ISSUER: "https://api.doxa.test",
  MCP_RESOURCE_URL: "https://mcp.doxa.test/mcp",
  AGENT_SIGNUP_ENABLED: "true",
};

const GRANT = {
  registrationId: "reg-1",
  claimToken: "doxa_clm_secret",
  claimTokenExpires: "2026-11-09T12:10:00.000Z",
  scopes: ["docs:read"],
  userCode: "123456",
  verificationUri: "https://doxa.test/oauth/claim?attempt=abc",
  expiresIn: 600,
  interval: 5,
};

const claims = { register: vi.fn(), poll: vi.fn() };
const revokeToken = vi.fn(async () => {});
const provider = vi.fn(() => Response.json({ issuer: env.OAUTH_ISSUER, grant_types_supported: ["authorization_code"] }));

function app() {
  const router = createApiRouter();
  router.use("*", agentSignupDispatch({ claims: () => claims, revokeToken }));
  router.all("*", provider);
  return router;
}

function postIdentity(body: unknown, overrides: { env?: object; headers?: Record<string, string> } = {}) {
  return app().request(
    "/agent/identity",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...overrides.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    overrides.env ?? env,
  );
}

function postToken(fields: Record<string, string>) {
  return app().request(
    "/oauth/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  claims.register.mockResolvedValue({ kind: "registered", grant: GRANT });
});

describe("POST /agent/identity", () => {
  it("returns the protocol fields and forbids storage of the response", async () => {
    const response = await postIdentity({ type: "service_auth", client_name: "Claude Code" }, { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      registration_id: "reg-1",
      registration_type: "service_auth",
      claim_token: "doxa_clm_secret",
      claim_token_expires: GRANT.claimTokenExpires,
      post_claim_scopes: ["docs:read"],
      claim: { user_code: "123456", verification_uri: GRANT.verificationUri, expires_in: 600, interval: 5 },
    });
    expect(claims.register).toHaveBeenCalledWith(expect.anything(), { clientIpKey: "203.0.113.9", webOrigin: "https://doxa.test" });
  });

  it.each([
    ["broken JSON", "{", "invalid_request"],
    ["a name with markup", { type: "service_auth", client_name: "<script>" }, "invalid_request"],
    ["a name that is too long", { type: "service_auth", client_name: "a".repeat(61) }, "invalid_request"],
    ["a bad email", { type: "service_auth", login_hint: "nope" }, "invalid_request"],
    ["another identity type", { type: "anonymous" }, "unsupported_identity_type"],
  ])("rejects %s", async (_label, body, code) => {
    const response = await postIdentity(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: code });
    expect(claims.register).not.toHaveBeenCalled();
  });

  it("answers 429 with the protocol error when limited", async () => {
    claims.register.mockResolvedValue({ kind: "rate_limited" });
    const response = await postIdentity({ type: "service_auth" });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "rate_limit_exceeded" });
  });

  it("answers 503 when the switch is off", async () => {
    claims.register.mockRejectedValue(new AgentSignupDisabledError());
    const response = await postIdentity({ type: "service_auth" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("does not treat a percent-encoded path as this route", async () => {
    await app().request("/agent/%69dentity", { method: "POST", body: "{}" }, env);
    expect(claims.register).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("rejects a body over the limit and other methods", async () => {
    expect((await postIdentity({ type: "service_auth", padding: "a".repeat(20_000) })).status).toBe(413);
    expect((await app().request("/agent/identity", { method: "GET" }, env)).status).toBe(405);
  });
});

describe("POST /oauth/token", () => {
  it.each([
    [{ kind: "pending", stage: "link_not_opened" }, "authorization_pending", "link_not_opened"],
    [{ kind: "slow_down" }, "slow_down", "Poll less often."],
    [{ kind: "denied" }, "access_denied", "The claim was denied or locked."],
    [{ kind: "invalid" }, "invalid_grant", "The claim token is not valid."],
  ])("maps %j to a protocol error", async (poll, code, description) => {
    claims.poll.mockResolvedValue(poll);
    const response = await postToken({ grant_type: AGENT_CLAIM_GRANT_TYPE, claim_token: "doxa_clm_x" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code, error_description: description });
    expect(provider).not.toHaveBeenCalled();
  });

  it("returns an issued token without caching", async () => {
    claims.poll.mockResolvedValue({ kind: "issued", accessToken: "doxa_at_x", expiresIn: 100, scope: "docs:read", mcpUrl: env.MCP_RESOURCE_URL });
    const response = await postToken({ grant_type: AGENT_CLAIM_GRANT_TYPE, claim_token: "doxa_clm_x" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ access_token: "doxa_at_x", token_type: "Bearer", expires_in: 100, scope: "docs:read", mcp_url: env.MCP_RESOURCE_URL });
  });

  it("leaves every other token request to the OAuth provider", async () => {
    await postToken({ grant_type: "authorization_code", code: "abc" });
    await postToken({ token: "some-provider-token" });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(claims.poll).not.toHaveBeenCalled();
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it("revokes an agent token by its hash, and keeps the plain token out of storage calls", async () => {
    const token = newAgentToken();
    const response = await postToken({ token });
    expect(response.status).toBe(200);
    expect(revokeToken).toHaveBeenCalledWith(env, await sha256Hex(token));
  });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  const path = "/.well-known/oauth-authorization-server";

  it("adds the claim grant and the agent_auth block", async () => {
    const response = await app().request(path, {}, env);
    expect(await response.json()).toEqual({
      issuer: env.OAUTH_ISSUER,
      grant_types_supported: ["authorization_code", AGENT_CLAIM_GRANT_TYPE],
      agent_auth: {
        skill: "https://doxa.test/auth.md",
        identity_endpoint: "https://api.doxa.test/agent/identity",
        identity_types_supported: ["service_auth"],
      },
    });
  });

  it("does not advertise the flow when the switch is off", async () => {
    const response = await app().request(path, {}, { ...env, AGENT_SIGNUP_ENABLED: "false" });
    expect(await response.json()).toEqual({ issuer: env.OAUTH_ISSUER, grant_types_supported: ["authorization_code"] });
  });
});
