import { InsufficientScopeError } from "@modelcontextprotocol/client";
import type { AuthInfo, JSONRPCRequest } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { scopeChallengeFor } from "../src/scope-challenge";
import { PROJECT_A } from "./support/fixtures";
import { createHarness, RESOURCE_URL } from "./support/harness";
import { callTool, rawToolCall, toolError } from "./support/tool-calls";

const REQUEST: JSONRPCRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "read_page", arguments: {} },
};

function authInfo(scopes: string[]): AuthInfo {
  return { token: "t", clientId: "client-1", scopes, resource: new URL(RESOURCE_URL) };
}

const METADATA_URL = "http://localhost:8791/.well-known/oauth-protected-resource/mcp";

describe("scopeChallengeFor", () => {
  const challenge = scopeChallengeFor("docs:read");

  it("asks for the one scope the tool needs, not the full set", () => {
    expect(challenge({ request: REQUEST, authInfo: authInfo(["projects:read", "unknown:scope"]) })).toEqual({
      scopes: ["docs:read"],
      errorDescription: "This tool needs the docs:read scope.",
    });
  });

  it("allows a token with the scope", () => {
    expect(challenge({ request: REQUEST, authInfo: authInfo(["docs:read"]) })).toBeUndefined();
  });

  it("counts implied scopes", () => {
    expect(challenge({ request: REQUEST, authInfo: authInfo(["publish"]) })).toBeUndefined();
  });

  it("leaves a request without a token to the OAuth gate", () => {
    expect(challenge({ request: REQUEST })).toBeUndefined();
  });
});

describe("per-tool scope challenge (2026-07-28 clients)", () => {
  it("answers 403 with the single missing scope before the tool runs", async () => {
    const harness = createHarness({ scopes: ["projects:read", "docs:read"] });
    const response = await rawToolCall(harness, "write_page", {
      projectId: PROJECT_A,
      branch: "22222222-2222-4222-8222-222222222222",
      href: "/install",
      content: "# Install",
    });
    expect(response.status).toBe(403);
    const header = response.headers.get("www-authenticate") ?? "";
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="docs:write"');
    expect(header).toContain('error_description="This tool needs the docs:write scope."');
    expect(header).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(await response.json()).toMatchObject({ error: "insufficient_scope" });
    expect(harness.calls).toEqual([]);
    expect(harness.toolCalls).toEqual([]);
    await harness.settle();
    expect(harness.closed.count).toBe(1);
  });

  it("surfaces the challenge to the SDK client as InsufficientScopeError", async () => {
    const harness = createHarness({ scopes: ["projects:read"] });
    const client = await harness.connect("modern");
    const error = await callTool(client, "read_page", { projectId: PROJECT_A, href: "/" }).catch((cause) => cause);
    expect(error).toBeInstanceOf(InsufficientScopeError);
    expect([error.requiredScope, String(error.resourceMetadataUrl)]).toEqual(["docs:read", METADATA_URL]);
    expect(harness.toolCalls).toEqual([]);
  });

  it("lets a call with the scope reach the tool", async () => {
    const harness = createHarness({ scopes: ["docs:write"] });
    const response = await rawToolCall(harness, "read_page", { projectId: PROJECT_A, href: "/install" });
    expect(response.status).toBe(200);
    expect(harness.toolCalls).toHaveLength(1);
  });

  it("never challenges a tool without a scope", async () => {
    const harness = createHarness({ scopes: [] });
    const response = await rawToolCall(harness, "get_account", {});
    expect(response.status).toBe(200);
  });
});

describe("missing scope on 2025 clients", () => {
  it("keeps the v1 tool error, which a client without step-up can show", async () => {
    const harness = createHarness({ scopes: ["projects:read"] });
    const client = await harness.connect("legacy");
    const outcome = await callTool(client, "read_page", { projectId: PROJECT_A, href: "/" });
    expect(toolError(outcome)).toMatchObject({ code: "insufficient_scope" });
    expect(harness.calls).toEqual([]);
  });
});
