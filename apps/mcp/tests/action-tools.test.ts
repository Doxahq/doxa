import { describe, expect, it } from "vitest";
import { AGENT_ACTIONS } from "@doxahq/api/services/agent-actions/registry";
import { TOOLS } from "../src/tools";
import { PENDING_REQUEST_ID } from "./support/fake-actions-rpc";
import { BRANCH_ID, PROJECT_A } from "./support/fixtures";
import { createHarness } from "./support/harness";
import { callTool, toolError } from "./support/tool-calls";

describe("action tool registry", () => {
  const actionTools = TOOLS.filter((tool) => tool.action !== undefined);

  it("covers every registered action exactly once", () => {
    const kinds = actionTools.map((tool) => tool.action);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(new Set(kinds)).toEqual(new Set(AGENT_ACTIONS.kinds));
  });

  it("gives each action tool the scope of its action", () => {
    for (const tool of actionTools) {
      if (tool.action === undefined) continue;
      expect([tool.name, tool.scope]).toEqual([tool.name, AGENT_ACTIONS.get(tool.action).scope]);
    }
  });
});

describe("action tools", () => {
  it("returns an approval link when doxa-api gates the action", async () => {
    const harness = createHarness();
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "publish_branch", {
      projectId: PROJECT_A,
      branchId: BRANCH_ID,
      summary: "Add rate-limit docs.",
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.structured).toMatchObject({
      outcome: "approval_required",
      request: { id: PENDING_REQUEST_ID, approvalUrl: `https://doxa.so/approve/${PENDING_REQUEST_ID}` },
    });
    expect(harness.actionCalls).toEqual([
      expect.objectContaining({
        action: "docs.publish",
        projectId: PROJECT_A,
        payload: { branchId: BRANCH_ID, eraseBranch: false },
        summary: "Add rate-limit docs.",
        actor: expect.objectContaining({ userId: "owner-user", clientId: "client-1" }),
      }),
    ]);
  });

  it("records approval_required with the request in the activity log", async () => {
    const harness = createHarness();
    const client = await harness.connect("modern");
    await callTool(client, "publish_branch", { projectId: PROJECT_A, branchId: BRANCH_ID, summary: "Publish." });
    await harness.settle();
    expect(harness.activity).toEqual([
      expect.objectContaining({
        tool: "publish_branch",
        outcome: "approval_required",
        actionKind: "docs.publish",
        approvalRequestId: PENDING_REQUEST_ID,
      }),
    ]);
  });

  it("returns the result when the policy allows the action", async () => {
    const generation = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };
    const harness = createHarness({
      actions: {
        "generation.cancel": { ok: false, error: { code: "generation_finished", message: "The generation has already finished." } },
      },
    });
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "cancel_generation", { projectId: PROJECT_A, generationId: generation.id });
    expect(toolError(outcome)).toMatchObject({ code: "action_failed", details: { reason: "generation_finished" } });
  });

  it("maps a denial from doxa-api to the same code as a local denial", async () => {
    const harness = createHarness({
      actions: { "docs.publish": { ok: false, error: { code: "project_not_in_grant", message: "x" } } },
    });
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "publish_branch", {
      projectId: PROJECT_A,
      branchId: BRANCH_ID,
      summary: "Publish.",
    });
    expect(toolError(outcome).code).toBe("project_not_in_grant");
  });

  it("maps a stale request", async () => {
    const harness = createHarness({
      actions: { "docs.restore": { ok: false, error: { code: "main_moved", message: "The live site changed." } } },
    });
    const client = await harness.connect("legacy");
    const outcome = await callTool(client, "restore_publication", {
      projectId: PROJECT_A,
      publicationId: BRANCH_ID,
    });
    expect(toolError(outcome)).toMatchObject({ code: "stale", details: { reason: "main_moved" } });
  });

  it("reports a publish blocked by MDX issues with the pages and a fix hint", async () => {
    const message =
      "Publish blocked: 1 page has MDX issues. /setup (source/setup/index.mdx line 7): Unknown MDX component: Bogus. Fix them, then publish again.";
    const harness = createHarness({
      actions: { "docs.publish": { ok: false, error: { code: "mdx_invalid", message } } },
    });
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "publish_branch", {
      projectId: PROJECT_A,
      branchId: BRANCH_ID,
      summary: "Publish.",
    });
    expect(toolError(outcome)).toMatchObject({
      code: "mdx_invalid",
      message,
      hint: expect.stringContaining("write_page"),
    });
  });

  it("refuses an action tool without its scope, before calling doxa-api", async () => {
    const harness = createHarness({ scopes: ["docs:read"] });
    const client = await harness.connect("legacy");
    const outcome = await callTool(client, "delete_project", { projectId: PROJECT_A });
    expect(toolError(outcome).code).toBe("insufficient_scope");
    expect(harness.actionCalls).toEqual([]);
  });

  it("reads and cancels approval requests of this connection", async () => {
    const harness = createHarness({ scopes: ["docs:read"] });
    const client = await harness.connect("modern");
    expect((await callTool(client, "get_approval_request", { requestId: PENDING_REQUEST_ID })).structured).toMatchObject({
      status: "pending",
    });
    expect((await callTool(client, "list_approval_requests", {})).structured).toMatchObject({
      requests: [{ id: PENDING_REQUEST_ID }],
    });
    expect((await callTool(client, "cancel_approval_request", { requestId: PENDING_REQUEST_ID })).structured).toMatchObject({
      status: "cancelled",
    });
  });
});
