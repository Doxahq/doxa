import { describe, expect, it } from "vitest";
import { MAX_MCP_BODY_BYTES } from "../src/request-body";
import { GRANT_REF, OWNER, PROJECT_A } from "./support/fixtures";
import { createHarness, RESOURCE_URL, workerRequest } from "./support/harness";
import {
  callTool,
  modernToolCallRequest,
  rawToolCall,
} from "./support/tool-calls";

describe("handleAuthenticatedMcpRequest", () => {
  it("rejects grant props that fail the schema as an invalid token", async () => {
    const harness = createHarness({
      props: {
        version: 2,
        grantRef: GRANT_REF,
        userId: OWNER,
        clientName: "x",
        projectScope: { kind: "all" },
      },
    });
    const response = await rawToolCall(harness, "get_account", {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost:8791/.well-known/oauth-protected-resource/mcp"',
    );
    expect(harness.toolCalls).toEqual([]);
  });

  it("answers 413 for a body over 4 MiB before MCP parsing", async () => {
    const harness = createHarness();
    const response = await harness.fetch(
      workerRequest(RESOURCE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(MAX_MCP_BODY_BYTES + 1),
      }),
    );
    expect(response.status).toBe(413);
    expect(harness.closed.count).toBe(0);
  });

  it("serves a 2025 client through the legacy lane: initialize, then tools/call", async () => {
    const harness = createHarness();
    const client = await harness.connect("legacy");
    expect(client.getServerVersion()).toMatchObject({ name: "doxa" });
    expect(client.getInstructions()).toContain("publish_branch");
    const outcome = await callTool(client, "get_project", {
      projectId: PROJECT_A,
    });
    expect(outcome.isError).toBe(false);
  });

  it("closes the request database scope after the response body ends", async () => {
    const harness = createHarness();
    const response = await harness.fetch(
      modernToolCallRequest("get_project", { projectId: PROJECT_A }),
    );
    await response.text();
    await harness.settle();
    expect(harness.closed.count).toBe(1);
  });

  it("rejects a request for another host", async () => {
    const harness = createHarness();
    const request = modernToolCallRequest("get_account", {});
    request.headers.set("host", "evil.example");
    const response = await harness.fetch(request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(harness.toolCalls).toEqual([]);
  });
});

describe("resources", () => {
  it("reads the live MDX source of a page", async () => {
    const client = await createHarness().connect("modern");
    const result = await client.readResource({
      uri: `doxa://projects/${PROJECT_A}/pages/install`,
    });
    expect(result.contents).toEqual([
      expect.objectContaining({
        mimeType: "text/markdown",
        text: "# Install\n\nPublished.",
      }),
    ]);
  });

  it("hides another user's page", async () => {
    const client = await createHarness({ userId: "other-user" }).connect(
      "modern",
    );
    await expect(
      client.readResource({
        uri: `doxa://projects/${PROJECT_A}/pages/install`,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("needs docs:read for a page", async () => {
    const client = await createHarness({ scopes: ["projects:read"] }).connect(
      "modern",
    );
    await expect(
      client.readResource({
        uri: `doxa://projects/${PROJECT_A}/pages/install`,
      }),
    ).rejects.toThrow(/docs:read/);
  });

  it("serves the site config JSON schema to any token", async () => {
    const client = await createHarness({ scopes: [] }).connect("modern");
    const result = await client.readResource({
      uri: "doxa://schemas/site-config",
    });
    const [content] = result.contents;
    expect(
      content && "text" in content ? JSON.parse(content.text) : null,
    ).toMatchObject({
      type: "object",
    });
  });
});
