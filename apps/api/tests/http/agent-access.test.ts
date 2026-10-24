import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSessionUser: vi.fn() }));

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("@doxahq/auth", () => ({
  getSessionUser: mocks.getSessionUser,
  getTrustedOrigins: (env: { WEB_ORIGIN?: string }) => [env.WEB_ORIGIN].filter(Boolean),
}));

const { createApiRouter } = await import("../../src/http/app");
const { corsPolicy, csrfProtection } = await import("../../src/http/middleware");
const { createAgentAccessRoutes, createOAuthAuthorizeRoutes } = await import(
  "../../src/routes/agent-access"
);
const { AuthorizeHandler } = await import("../../src/services/oauth/authorize-handler");
const { GrantsService } = await import("../../src/services/oauth/grants-service");
const { noAgentActivity } = await import("../../src/services/oauth/agent-activity-lookup");
const { OAuthNotConfiguredError } = await import("../../src/services/oauth/oauth-config");
const {
  CONSENT_ID,
  ISSUER,
  MemoryConsentStore,
  NOW,
  OTHER,
  OTHER_PROJECT,
  OWNER,
  PROJECT_A,
  consentService,
  fakeOAuthApi,
  grantSummary,
  pendingConsent,
} = await import("../services/oauth/fixtures");

const WEB_ORIGIN = "https://doxa.test";
const env = { WEB_ORIGIN };

let store: InstanceType<typeof MemoryConsentStore>;
let oauth: ReturnType<typeof fakeOAuthApi>;

function createApp(configured = true) {
  const unavailable = () => {
    throw new OAuthNotConfiguredError(["OAUTH_KV"]);
  };
  const services = {
    authorize: configured
      ? () =>
          new AuthorizeHandler({
            oauth,
            consents: store,
            now: () => NOW,
            newConsentId: () => CONSENT_ID,
          })
      : unavailable,
    consents: configured ? () => consentService(store, oauth) : unavailable,
    grants: configured ? () => new GrantsService({ oauth, activity: noAgentActivity }) : unavailable,
  };
  const app = createApiRouter();
  app.use("*", corsPolicy());
  app.use("*", csrfProtection());
  app.route("/oauth", createOAuthAuthorizeRoutes(services));
  app.route("/agent-access", createAgentAccessRoutes(services));
  return app;
}

function send(
  path: string,
  options: { method?: string; body?: unknown; origin?: string | null; configured?: boolean } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
  if (origin !== null) headers.set("origin", origin);
  return createApp(options.configured).request(
    `${ISSUER}${path}`,
    {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    env,
  );
}

const approveBody = { scopes: ["docs:read"], projectScope: { kind: "all" } };

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: OWNER, email: "owner@doxa.so" });
  store = new MemoryConsentStore();
  oauth = fakeOAuthApi({ listUserGrants: async () => ({ items: [grantSummary()] }) });
  await store.save(CONSENT_ID, pendingConsent());
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /oauth/authorize", () => {
  test("parks the request and redirects to the web consent page without a session", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    store.consents.clear();

    const response = await send("/oauth/authorize?client_id=client-abc", { origin: null });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${WEB_ORIGIN}/oauth/consent?id=${CONSENT_ID}`);
    expect(store.consents.has(CONSENT_ID)).toBe(true);
  });

  test("answers 503 when OAuth is not configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await send("/oauth/authorize", { configured: false });

    expect(response.status).toBe(503);
  });
});

describe("consent routes", () => {
  test("require a session", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    expect((await send(`/agent-access/consents/${CONSENT_ID}`)).status).toBe(401);
    expect(
      (await send(`/agent-access/consents/${CONSENT_ID}/approve`, { method: "POST", body: approveBody }))
        .status,
    ).toBe(401);
    expect(store.consents.has(CONSENT_ID)).toBe(true);
  });

  test("return the consent details", async () => {
    const response = await send(`/agent-access/consents/${CONSENT_ID}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      consentId: CONSENT_ID,
      client: { name: "Claude Code", verified: false },
      requestedScopes: ["docs:read", "docs:write"],
    });
  });

  test("return 404 for an unknown consent", async () => {
    expect((await send(`/agent-access/consents/${"z".repeat(43)}`)).status).toBe(404);
  });

  test.each([
    ["no origin", null],
    ["an untrusted origin", "https://evil.example"],
  ])("reject approve with %s", async (_label, origin) => {
    const response = await send(`/agent-access/consents/${CONSENT_ID}/approve`, {
      method: "POST",
      body: approveBody,
      origin,
    });

    expect(response.status).toBe(403);
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
    expect(store.consents.has(CONSENT_ID)).toBe(true);
  });

  test("reject deny with an untrusted origin", async () => {
    const response = await send(`/agent-access/consents/${CONSENT_ID}/deny`, {
      method: "POST",
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
    expect(store.consents.has(CONSENT_ID)).toBe(true);
  });

  test("approve for the session user and return the redirect", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: OTHER });

    const response = await send(`/agent-access/consents/${CONSENT_ID}/approve`, {
      method: "POST",
      body: { scopes: ["docs:read"], projectScope: { kind: "selected", projectIds: [OTHER_PROJECT] } },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirectTo: "http://127.0.0.1:9999/callback?code=abc&state=state-1",
    });
    expect(oauth.completeAuthorization.mock.calls[0][0].userId).toBe(OTHER);
  });

  test("never take the user ID from the body", async () => {
    const response = await send(`/agent-access/consents/${CONSENT_ID}/approve`, {
      method: "POST",
      body: { ...approveBody, userId: OTHER },
    });

    expect(response.status).toBe(400);
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  test("reject another user's project with 422", async () => {
    const response = await send(`/agent-access/consents/${CONSENT_ID}/approve`, {
      method: "POST",
      body: { scopes: ["docs:read"], projectScope: { kind: "selected", projectIds: [PROJECT_A, OTHER_PROJECT] } },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { details: { code: "validation_failed", issues: [{ path: "/projectScope/projectIds/1" }] } },
    });
  });

  test("reject a scope the agent did not request with 422", async () => {
    const response = await send(`/agent-access/consents/${CONSENT_ID}/approve`, {
      method: "POST",
      body: { scopes: ["publish"], projectScope: { kind: "all" } },
    });

    expect(response.status).toBe(422);
  });

  test("approve only once", async () => {
    const path = `/agent-access/consents/${CONSENT_ID}/approve`;

    expect((await send(path, { method: "POST", body: approveBody })).status).toBe(200);
    expect((await send(path, { method: "POST", body: approveBody })).status).toBe(404);
  });

  test("deny returns the access_denied redirect", async () => {
    const response = await send(`/agent-access/consents/${CONSENT_ID}/deny`, { method: "POST" });

    expect(response.status).toBe(200);
    const body: { redirectTo: string } = await response.json();
    expect(new URL(body.redirectTo).searchParams.get("error")).toBe("access_denied");
    expect(store.consents.has(CONSENT_ID)).toBe(false);
  });
});

describe("grant routes", () => {
  test("list the session user's grants", async () => {
    const response = await send("/agent-access/grants");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      grants: [
        {
          grantId: "grant-1",
          clientName: "Claude Code",
          scopes: ["docs:read"],
          projectScope: { kind: "all" },
          createdAt: NOW.toISOString(),
          lastActivityAt: null,
        },
      ],
    });
    expect(oauth.listUserGrants).toHaveBeenCalledWith(OWNER, expect.anything());
  });

  test("require a session", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    expect((await send("/agent-access/grants")).status).toBe(401);
  });

  test("revoke a grant", async () => {
    const response = await send("/agent-access/grants/grant-1", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(oauth.revokeGrant).toHaveBeenCalledWith("grant-1", OWNER);
  });

  test("return 404 for a grant the user does not hold", async () => {
    expect((await send("/agent-access/grants/grant-9", { method: "DELETE" })).status).toBe(404);
    expect(oauth.revokeGrant).not.toHaveBeenCalled();
  });

  test("reject revoke with an untrusted origin", async () => {
    const response = await send("/agent-access/grants/grant-1", {
      method: "DELETE",
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
    expect(oauth.revokeGrant).not.toHaveBeenCalled();
  });

  test("answer 503 when OAuth is not configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await send("/agent-access/grants", { configured: false })).status).toBe(503);
  });
});
