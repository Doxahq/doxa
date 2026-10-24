import {
  agentGrantPropsSchema,
  OAUTH_SCOPES,
} from "@doxahq/contracts/agent-access";
import { describe, expect, it } from "vitest";
import { devAuthContext } from "../src/dev-auth";
import type { McpEnv } from "../src/mcp-env";
import { createMemoryR2Bucket } from "@doxahq/api/tests/support/memory-r2-bucket";

function env(bypass: string | undefined): McpEnv {
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  return {
    AUTH_SERVER: { validateToken: async () => null },
    DOCS_BUCKET: createMemoryR2Bucket().bucket,
    MCP_READ_LIMITER: limiter,
    MCP_WRITE_LIMITER: limiter,
    MCP_EXPENSIVE_LIMITER: limiter,
    MCP_RESOURCE_URL: "http://localhost:8791/mcp",
    OAUTH_ISSUER: "http://localhost:8787",
    MCP_DEV_AUTH_BYPASS: bypass,
  };
}

function request(url: string, headers: Record<string, string>): Request {
  return new Request(url, { method: "POST", headers });
}

const noWait = () => undefined;

describe("devAuthContext", () => {
  it("builds a fake grant for a localhost request with the user header", () => {
    const ctx = devAuthContext(
      request("http://localhost:8791/mcp", {
        "x-doxa-dev-user-id": "local-dev-user",
      }),
      env("true"),
      noWait,
    );
    expect(agentGrantPropsSchema.parse(ctx?.props)).toMatchObject({
      userId: "local-dev-user",
    });
    expect(ctx?.auth).toMatchObject({
      audience: "http://localhost:8791/mcp",
      scope: [...OAUTH_SCOPES],
    });
  });

  it("takes the scopes from the scopes header and drops unknown ones", () => {
    const ctx = devAuthContext(
      request("http://127.0.0.1:8791/mcp", {
        "x-doxa-dev-user-id": "local-dev-user",
        "x-doxa-dev-scopes": "docs:read  admin projects:read",
      }),
      env("true"),
      noWait,
    );
    expect(ctx?.auth.scope).toEqual(["docs:read", "projects:read"]);
  });

  it.each([
    [
      "the flag is off",
      "http://localhost:8791/mcp",
      { "x-doxa-dev-user-id": "u" },
      "false",
    ],
    [
      "the flag is missing",
      "http://localhost:8791/mcp",
      { "x-doxa-dev-user-id": "u" },
      undefined,
    ],
    [
      "the host is not local",
      "https://mcp.doxa.so/mcp",
      { "x-doxa-dev-user-id": "u" },
      "true",
    ],
    ["the user header is missing", "http://localhost:8791/mcp", {}, "true"],
  ])("does nothing when %s", (_label, url, headers, bypass) => {
    expect(
      devAuthContext(request(url, headers), env(bypass), noWait),
    ).toBeNull();
  });
});
