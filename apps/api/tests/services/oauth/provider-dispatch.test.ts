import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("@doxahq/auth", () => ({
  createAuth: vi.fn(),
  getSessionUser: vi.fn(async () => null),
  getTrustedOrigins: (env: { WEB_ORIGIN?: string }) => [env.WEB_ORIGIN].filter(Boolean),
}));

const worker = (await import("../../../src/index")).default;
const { authorizationServerFor, isOAuthProviderPath } = await import(
  "../../../src/services/oauth/authorization-server"
);
const { createMemoryKv } = await import("./memory-kv");
const { ISSUER, MCP_RESOURCE } = await import("./fixtures");

function configuredEnv() {
  return {
    WEB_ORIGIN: "https://doxa.test",
    OAUTH_KV: createMemoryKv().kv,
    OAUTH_ISSUER: ISSUER,
    MCP_RESOURCE_URL: MCP_RESOURCE,
  };
}

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

function dispatch(path: string, env: object, init?: RequestInit) {
  // The worker's env type is the full Env; these tests only need OAuth bindings.
  return worker.fetch(new Request(`${ISSUER}${path}`, init), env, executionContext);
}

describe("isOAuthProviderPath", () => {
  it.each([
    ["/.well-known/oauth-authorization-server", true],
    ["/oauth/token", true],
    ["/oauth/register", true],
    ["/oauth/authorize", false],
    ["/oauth/authorize/", false],
    ["/oauth", false],
    ["/projects", false],
    ["/health", false],
    ["/agent-access/grants", false],
  ])("%s -> %s", (path, expected) => {
    expect(isOAuthProviderPath(path)).toBe(expected);
  });
});

describe("worker dispatch", () => {
  it("serves authorization server metadata from the provider", async () => {
    const response = await dispatch("/.well-known/oauth-authorization-server", configuredEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      scopes_supported: expect.arrayContaining(["docs:write", "offline_access"]),
    });
  });

  it("sends registration to the provider, skipping the Hono CSRF check", async () => {
    const response = await dispatch("/oauth/register", configuredEnv(), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://agent.example" },
      body: JSON.stringify({
        client_name: "Test Agent",
        redirect_uris: ["http://127.0.0.1:9999/callback"],
        token_endpoint_auth_method: "none",
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ client_name: "Test Agent" });
  });

  it("sends the token endpoint to the provider", async () => {
    const response = await dispatch("/oauth/token", configuredEnv(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toHaveProperty("error");
  });

  it("sends /oauth/authorize to the Hono route", async () => {
    const response = await dispatch("/oauth/authorize", configuredEnv());

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    // Hono's security headers prove the request went through the Hono app.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps other routes on Hono", async () => {
    const response = await dispatch("/health", configuredEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "doxa-api" });
  });

  it("answers 503 on OAuth paths without OAuth config and keeps other routes up", async () => {
    const env = { WEB_ORIGIN: "https://doxa.test" };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await dispatch("/.well-known/oauth-authorization-server", env)).status).toBe(503);
    expect((await dispatch("/oauth/authorize?client_id=x", env)).status).toBe(503);
    expect((await dispatch("/health", env)).status).toBe(200);
    errorLog.mockRestore();
  });
});

describe("authorizationServerFor", () => {
  it("reuses the server for the same config and rebuilds it when the config changes", () => {
    const config = { issuer: ISSUER, mcpResource: MCP_RESOURCE };
    const first = authorizationServerFor(config);

    expect(authorizationServerFor({ ...config })).toBe(first);
    expect(
      authorizationServerFor({ issuer: "https://other.test", mcpResource: MCP_RESOURCE }),
    ).not.toBe(first);
  });
});
