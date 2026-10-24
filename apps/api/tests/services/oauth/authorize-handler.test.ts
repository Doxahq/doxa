import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { AuthorizationError, CimdFetchError } = await import("@cloudflare/workers-oauth-provider");
const { AuthorizeHandler } = await import("../../../src/services/oauth/authorize-handler");
const { CONSENT_ID, ISSUER, MemoryConsentStore, NOW, authRequest, fakeOAuthApi } = await import(
  "./fixtures"
);

const WEB_ORIGIN = "https://doxa.test";
const request = new Request(`${ISSUER}/oauth/authorize?client_id=client-abc`);

function setup(oauth = fakeOAuthApi()) {
  const consents = new MemoryConsentStore();
  const handler = new AuthorizeHandler({
    oauth,
    consents,
    now: () => NOW,
    newConsentId: () => CONSENT_ID,
  });
  return { handler, consents };
}

describe("AuthorizeHandler", () => {
  it("parks a valid request and redirects to the web consent page", async () => {
    const { handler, consents } = setup();

    const response = await handler.handle(request, WEB_ORIGIN);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${WEB_ORIGIN}/oauth/consent?id=${CONSENT_ID}`,
    );
    expect(consents.consents.get(CONSENT_ID)).toEqual({
      authRequest: authRequest(),
      client: { clientId: "client-abc", clientName: "Claude Code" },
      createdAt: NOW.toISOString(),
    });
  });

  it("shows a local error page, with no redirect, for an unverified client", async () => {
    const { handler, consents } = setup(
      fakeOAuthApi({
        parseAuthRequest: async () => {
          throw new AuthorizationError("invalid_request", { description: "Invalid client_id" });
        },
      }),
    );

    const response = await handler.handle(request, WEB_ORIGIN);

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain("Invalid client_id");
    expect(consents.consents.size).toBe(0);
  });

  it("escapes the error description on the error page", async () => {
    const { handler } = setup(
      fakeOAuthApi({
        parseAuthRequest: async () => {
          throw new AuthorizationError("invalid_request", { description: "<script>x</script>" });
        },
      }),
    );

    const body = await (await handler.handle(request, WEB_ORIGIN)).text();

    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("redirects to the client when the provider made a safe error redirect", async () => {
    const { handler, consents } = setup(
      fakeOAuthApi({
        parseAuthRequest: async () => {
          throw new AuthorizationError("invalid_scope", {
            description: "Unknown scope",
            redirectUri: "http://127.0.0.1:9999/callback",
            state: "state-1",
            issuer: ISSUER,
          });
        },
      }),
    );

    const response = await handler.handle(request, WEB_ORIGIN);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("http://127.0.0.1:9999/callback");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(consents.consents.size).toBe(0);
  });

  it("shows a local error page when a client metadata document fails to load", async () => {
    const { handler } = setup(
      fakeOAuthApi({
        parseAuthRequest: async () => {
          throw new CimdFetchError("https://agent.example/client.json", new Error("HTTP 404"));
        },
      }),
    );

    const response = await handler.handle(request, WEB_ORIGIN);

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("metadata document could not be loaded");
  });

  it("shows a local error page when the client disappears after parsing", async () => {
    const { handler } = setup(fakeOAuthApi({ lookupClient: async () => null }));

    const response = await handler.handle(request, WEB_ORIGIN);

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rethrows unexpected failures", async () => {
    const { handler } = setup(
      fakeOAuthApi({
        parseAuthRequest: async () => {
          throw new Error("KV unavailable");
        },
      }),
    );

    await expect(handler.handle(request, WEB_ORIGIN)).rejects.toThrow("KV unavailable");
  });
});
