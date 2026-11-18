import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const resourceFetch = vi.fn(async () => new Response("validated", { status: 401 }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthResourceServer: class {
    fetch = resourceFetch;
  },
}));

const worker = (await import("../src/index")).default;

const env = {
  OAUTH_ISSUER: "https://api.doxa.so",
  MCP_RESOURCE_URL: "https://mcp.doxa.so/mcp",
};

describe("MCP health route", () => {
  test("answers GET /health without a token", async () => {
    resourceFetch.mockClear();

    const response = await worker.fetch(
      new Request("https://mcp.doxa.so/health") as never,
      env as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true, service: "doxa-mcp" });
    expect(resourceFetch).not.toHaveBeenCalled();
  });

  test("sends other methods on /health to token validation", async () => {
    resourceFetch.mockClear();

    const response = await worker.fetch(
      new Request("https://mcp.doxa.so/health", { method: "POST" }) as never,
      env as never,
      {} as never,
    );

    expect(response.status).toBe(401);
    expect(resourceFetch).toHaveBeenCalledTimes(1);
  });
});
