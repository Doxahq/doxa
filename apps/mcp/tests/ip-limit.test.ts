import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const resourceFetch = vi.fn(async () => new Response("validated", { status: 401 }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthResourceServer: class {
    fetch = resourceFetch;
  },
}));

const worker = (await import("../src/index")).default;

/** SECURITY REGRESSION GUARDRAIL (SEC-008): the IP limit runs before token validation. */
describe("MCP IP limit", () => {
  function env(success: boolean) {
    return {
      OAUTH_ISSUER: "https://api.doxa.so",
      MCP_RESOURCE_URL: "https://mcp.doxa.so/mcp",
      MCP_IP_LIMITER: { limit: vi.fn(async () => ({ success })) },
    };
  }

  function request() {
    return new Request("https://mcp.doxa.so/mcp", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9", authorization: "Bearer random" },
    });
  }

  test("answers 429 without validating the token when the IP is over the limit", async () => {
    resourceFetch.mockClear();
    const limited = env(false);

    const response = await worker.fetch(request() as never, limited as never, {} as never);

    expect(response.status).toBe(429);
    expect(limited.MCP_IP_LIMITER.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(resourceFetch).not.toHaveBeenCalled();
  });

  test("passes a request under the limit to token validation", async () => {
    resourceFetch.mockClear();

    const response = await worker.fetch(request() as never, env(true) as never, {} as never);

    expect(response.status).toBe(401);
    expect(resourceFetch).toHaveBeenCalledOnce();
  });
});
