import { describe, expect, it, vi } from "vitest";
import type { ApprovalNotifier } from "../../../src/services/agent-actions/approval-notifier";
import { AgentActionGateway } from "../../../src/services/agent-actions/gateway";
import { ApprovalService } from "../../../src/services/agent-actions/approval-service";
import { ApprovalSweeper } from "../../../src/services/agent-actions/approval-sweeper";
import {
  ApprovalPolicyResolver,
  type ApprovalMode,
} from "../../../src/services/agent-actions/policy/approval-policy";
import { PlatformOverrideSource } from "../../../src/services/agent-actions/policy/platform-overrides";
import { AGENT_ACTIONS, defineActionRegistry } from "../../../src/services/agent-actions/registry";
import { docsPublishAction } from "../../../src/services/agent-actions/actions/docs-publish";
import {
  ActionAccessDeniedError,
  ActionDeniedError,
  ConfirmationMismatchError,
  RequestNotPendingError,
} from "../../../src/services/agent-actions/errors";
import { AgentActionsRpcHandler } from "../../../src/services/agent-actions/rpc-handler";
import { DocsContentError } from "../../../src/services/docs-content/errors";
import { InMemoryAgentApprovalRequestStore } from "../../support/in-memory-agent-approval-requests";
import {
  BRANCH,
  fakeAccess,
  fakeServices,
  GRANT,
  ownerAgent,
  OWNER,
  ownerDashboard,
  PROJECT,
  STRANGER,
} from "./fakes";
import { agentActor, dashboardActor, toProjectId } from "../../../src/services/agent-access/actor";
import type { ActionAccessPolicy } from "../../../src/services/agent-actions/action-access";
import { OtherDeciderRequiredError } from "../../../src/services/agent-actions/errors";
import { InMemoryApprovalSettingsStore } from "../../support/in-memory-approval-settings";
import { InMemoryProjectAccess, membershipPolicy } from "../../support/in-memory-project-access";
import { MembershipProjectAccessPolicy } from "../../../src/services/agent-access/membership-project-access-policy";

const TEAM = "55555555-5555-4555-8555-555555555555";
const EDITOR = "editor-1";
const VIEWER = "viewer-1";

const NOW = new Date("2026-10-04T12:00:00Z");
const WEB_ORIGIN = "https://doxa.so";

function setup(
  options: {
    overrides?: { action: "docs.publish" | "project.delete"; mode: ApprovalMode }[];
    access?: ActionAccessPolicy;
  } = {},
) {
  const requests = new InMemoryAgentApprovalRequestStore();
  const fakes = fakeServices();
  const access = options.access ?? fakeAccess();
  const flags = new InMemoryApprovalSettingsStore([PROJECT]);
  const overrides = (options.overrides ?? []).map((entry) => ({
    action: entry.action,
    target: { kind: "project" as const, projectId: PROJECT },
    mode: entry.mode,
  }));
  const policy = new ApprovalPolicyResolver([new PlatformOverrideSource(overrides)], AGENT_ACTIONS.rulesFor, vi.fn());
  const activity = { append: vi.fn(async () => undefined) };
  const clock = { now: NOW };
  const now = () => clock.now;
  const notifier = { requested: vi.fn<ApprovalNotifier["requested"]>(), decided: vi.fn<ApprovalNotifier["decided"]>() };
  const gateway = new AgentActionGateway({
    registry: AGENT_ACTIONS,
    access,
    policy,
    requests,
    services: fakes.services,
    webOrigin: WEB_ORIGIN,
    now,
    notifier,
  });
  const approvals = new ApprovalService({
    registry: AGENT_ACTIONS,
    requests,
    access,
    services: fakes.services,
    activity,
    flags,
    users: { namesFor: async (ids) => new Map(ids.filter((id) => id in USER_NAMES).map((id) => [id, USER_NAMES[id]])) },
    defer: () => undefined,
    now,
    notifier,
  });
  const sweeper = new ApprovalSweeper({ registry: AGENT_ACTIONS, requests, access, services: fakes.services, policy, now });
  return { requests, fakes, gateway, approvals, sweeper, activity, flags, notifier, clock };
}

const USER_NAMES: Record<string, string> = { [OWNER]: "Olivia Owner", [EDITOR]: "Eddie Editor" };

const publishRequest = { action: "docs.publish" as const, projectId: PROJECT, payload: { branchId: BRANCH }, summary: "Add rate limits" };

async function pendingPublish(env: ReturnType<typeof setup>) {
  const result = await env.gateway.perform(ownerAgent(), publishRequest);
  if (result.outcome !== "approval_required") throw new Error("expected a pending request");
  return result;
}

describe("approval policy", () => {
  it("uses the action default when no source answers", async () => {
    const resolver = new ApprovalPolicyResolver([], AGENT_ACTIONS.rulesFor);
    await expect(resolver.resolve({ actor: ownerAgent(), projectId: null, action: "docs.publish" })).resolves.toEqual({
      mode: "require_approval",
      source: "action_default",
    });
  });

  it("lets a source relax a gate inside allowedModes", async () => {
    const env = setup({ overrides: [{ action: "docs.publish", mode: "allow" }] });
    const result = await env.gateway.perform(ownerAgent(), publishRequest);
    expect(result).toMatchObject({ outcome: "completed", policySource: "platform_override" });
    expect(env.fakes.publish).toHaveBeenCalledOnce();
  });

  it("ignores a mode outside allowedModes, so project delete never runs without a human", async () => {
    const ignored = vi.fn();
    const source = new PlatformOverrideSource([
      { action: "project.delete", target: { kind: "project", projectId: PROJECT }, mode: "allow" },
    ]);
    const resolver = new ApprovalPolicyResolver([source], AGENT_ACTIONS.rulesFor, ignored);
    const resolved = await resolver.resolve({ actor: ownerAgent(), projectId: toProjectId(PROJECT), action: "project.delete" });
    expect(resolved).toEqual({ mode: "require_approval", source: "action_default" });
    expect(ignored).toHaveBeenCalledWith({ source: "platform_override", action: "project.delete", mode: "allow" });
  });

  it("rejects duplicate kinds at registry build time", () => {
    expect(() => defineActionRegistry([docsPublishAction, docsPublishAction])).toThrow(/Duplicate/);
  });
});

describe("gateway", () => {
  it("creates a pending request with an approval link", async () => {
    const env = setup();
    const result = await pendingPublish(env);
    expect(result.pending).toMatchObject({ status: "pending", pollAfterMs: 10_000 });
    expect(result.pending.approvalUrl).toBe(`https://doxa.so/approve/${result.pending.id}`);
    expect(result.request.headline).toBe("Publish 2 changes from agent-rate-limits");
    expect(env.fakes.publish).not.toHaveBeenCalled();
  });

  it("returns the same request for an identical repeat", async () => {
    const env = setup();
    const first = await pendingPublish(env);
    const second = await pendingPublish(env);
    expect(second.pending.id).toBe(first.pending.id);
  });

  it("replaces a pending request when the branch changed", async () => {
    const env = setup();
    const first = await pendingPublish(env);
    const branch = env.fakes.state.branch;
    if (!branch) throw new Error("missing branch");
    env.fakes.state.branch = { ...branch, revision: 4 };
    const second = await pendingPublish(env);
    expect(second.pending.id).not.toBe(first.pending.id);
    expect(env.requests.rows.get(first.pending.id)?.status).toBe("stale");
  });

  it("starts no publish request while a changed page has MDX issues (spec 8.1)", async () => {
    const env = setup();
    env.fakes.state.mdxIssues = [
      {
        href: "/setup",
        sourcePath: "source/setup/index.mdx",
        issues: [{ line: 7, column: 1, message: "Unknown MDX component: Bogus" }],
      },
    ];
    await expect(env.gateway.perform(ownerAgent(), publishRequest)).rejects.toMatchObject({
      code: "mdx_invalid",
      message: expect.stringContaining("/setup (source/setup/index.mdx line 7): Unknown MDX component: Bogus"),
    });
    expect(env.requests.rows.size).toBe(0);
    expect(env.fakes.publish).not.toHaveBeenCalled();
  });

  it("blocks an allowed publish with MDX issues too", async () => {
    const env = setup({ overrides: [{ action: "docs.publish", mode: "allow" }] });
    env.fakes.state.mdxIssues = [
      { href: "/", sourcePath: "source/index.mdx", issues: [{ line: null, column: null, message: "Bad" }] },
    ];
    await expect(env.gateway.perform(ownerAgent(), publishRequest)).rejects.toMatchObject({ code: "mdx_invalid" });
    expect(env.fakes.publish).not.toHaveBeenCalled();
  });

  it("throws for deny", async () => {
    const env = setup({ overrides: [{ action: "docs.publish", mode: "deny" }] });
    await expect(env.gateway.perform(ownerAgent(), publishRequest)).rejects.toBeInstanceOf(ActionDeniedError);
  });

  it("refuses an agent without the scope", async () => {
    const env = setup();
    await expect(env.gateway.perform(ownerAgent(["docs:read"]), publishRequest)).rejects.toBeInstanceOf(
      ActionAccessDeniedError,
    );
  });
});

describe("approval service", () => {
  it("approves, publishes with the recorded preconditions, and records attribution", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    const detail = await env.approvals.approve(ownerDashboard(), pending.id);
    expect(detail.status).toBe("completed");
    expect(env.fakes.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { expectedBaseVersionId: expect.any(String), expectedRevision: 3, eraseBranch: false },
        attribution: { agentClientId: "client-1", agentClientName: "Claude Code", approvalRequestId: pending.id },
      }),
    );
    expect(env.activity.append).toHaveBeenCalledWith(expect.objectContaining({ outcome: "succeeded", grantRef: GRANT }));
  });

  it("lets the decider override the agent's choice to erase the branch", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    await env.approvals.approve(ownerDashboard(), pending.id, { eraseBranch: true });
    expect(env.fakes.publish).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ eraseBranch: true }) }),
    );
  });

  it("marks the request stale and runs nothing when the branch changed", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    const branch = env.fakes.state.branch;
    if (!branch) throw new Error("missing branch");
    env.fakes.state.branch = { ...branch, revision: 9 };
    const detail = await env.approvals.approve(ownerDashboard(), pending.id);
    expect(detail.status).toBe("stale");
    expect(env.fakes.publish).not.toHaveBeenCalled();
  });

  it("fails an approved publish that the publish service blocks for MDX issues", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    env.fakes.publish.mockRejectedValueOnce(
      new DocsContentError("mdx_invalid", "Publish blocked: 1 page has MDX issues."),
    );
    const detail = await env.approvals.approve(ownerDashboard(), pending.id);
    expect(detail.status).toBe("failed");
    expect(detail.error).toEqual({ code: "mdx_invalid", message: "Publish blocked: 1 page has MDX issues." });
  });

  // SECURITY REGRESSION GUARDRAIL (SEC-029): an expired request never runs, even before the sweeper.
  it("expires and refuses a request past its expiry", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    env.clock.now = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);

    await expect(env.approvals.approve(ownerDashboard(), pending.id)).rejects.toBeInstanceOf(RequestNotPendingError);

    expect((await env.requests.findById(pending.id as never))?.status).toBe("expired");
    expect(env.notifier.decided).not.toHaveBeenCalled();
  });

  it("fails a second approve", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    await env.approvals.approve(ownerDashboard(), pending.id);
    await expect(env.approvals.approve(ownerDashboard(), pending.id)).rejects.toBeInstanceOf(RequestNotPendingError);
  });

  it("hides the request from another user", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    await expect(env.approvals.approve(dashboardActor(STRANGER), pending.id)).rejects.toThrow("Approval request not found.");
  });

  it("returns the reject reason to the agent", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    await env.approvals.reject(ownerDashboard(), pending.id, "Fix the examples first.");
    const seen = await env.approvals.get(ownerAgent(), pending.id);
    expect(seen).toMatchObject({ status: "rejected", decisionNote: "Fix the examples first." });
  });

  it("needs the typed project name to delete a project", async () => {
    const env = setup();
    const result = await env.gateway.perform(ownerAgent(), {
      action: "project.delete",
      projectId: PROJECT,
      payload: {},
      summary: null,
    });
    if (result.outcome !== "approval_required") throw new Error("expected a pending request");
    await expect(env.approvals.approve(ownerDashboard(), result.pending.id, { confirmation: "acme" })).rejects.toBeInstanceOf(
      ConfirmationMismatchError,
    );
    const detail = await env.approvals.approve(ownerDashboard(), result.pending.id, { confirmation: "Acme" });
    expect(detail.status).toBe("completed");
    expect(env.fakes.deleteProject).toHaveBeenCalledOnce();
  });

  it("lets the requesting agent cancel, and nobody else", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    const otherClient = { ...ownerAgent(), channel: { ...ownerAgent().channel, clientId: "client-2" } };
    await expect(env.approvals.cancel(otherClient, pending.id)).rejects.toThrow("Approval request not found.");
    await expect(env.approvals.cancel(ownerAgent(), pending.id)).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("approvals in a team (spec §5)", () => {
  const teamAccess = () =>
    membershipPolicy(
      { [PROJECT]: { owner: OWNER, teamId: TEAM } },
      { [TEAM]: { [OWNER]: "owner", [EDITOR]: "editor", [VIEWER]: "viewer" } },
    );

  function editorAgent() {
    return agentActor({
      userId: EDITOR,
      clientId: "client-9",
      clientName: "Cursor",
      grantRef: GRANT,
      scopes: ["publish"],
      projectScope: { kind: "all" },
    });
  }

  async function editorRequest(env: ReturnType<typeof setup>) {
    const result = await env.gateway.perform(editorAgent(), publishRequest);
    if (result.outcome !== "approval_required") throw new Error("expected a pending request");
    return result.pending.id;
  }

  it("shows the member who asked and the agent, and who decided", async () => {
    const env = setup({ access: teamAccess() });
    const requestId = await editorRequest(env);
    const listed = await env.approvals.listForProject(dashboardActor(OWNER), PROJECT);
    expect(listed[0]?.requestedBy).toEqual({ userId: EDITOR, name: "Eddie Editor", clientName: "Cursor" });
    const detail = await env.approvals.approve(dashboardActor(OWNER), requestId);
    expect(detail.decidedBy).toEqual({ userId: OWNER, name: "Olivia Owner" });
  });

  it("lets any member with approvals.decide decide, and refuses a viewer", async () => {
    const env = setup({ access: teamAccess() });
    const { pending } = await pendingPublish(env);
    await expect(env.approvals.approve(dashboardActor(VIEWER), pending.id)).rejects.toMatchObject({ reason: "forbidden" });
    await expect(env.approvals.approve(dashboardActor(EDITOR), pending.id)).resolves.toMatchObject({ status: "completed" });
  });

  it("refuses a viewer's reject, as the detail's canReject says", async () => {
    const env = setup({ access: teamAccess() });
    const { pending } = await pendingPublish(env);
    await expect(env.approvals.review(dashboardActor(VIEWER), pending.id)).resolves.toMatchObject({
      viewer: { canReject: false },
    });
    await expect(env.approvals.reject(dashboardActor(VIEWER), pending.id)).rejects.toMatchObject({ reason: "forbidden" });
    await expect(env.approvals.review(dashboardActor(EDITOR), pending.id)).resolves.toMatchObject({
      status: "pending",
      viewer: { canReject: true },
    });
  });

  it("needs the decider's role to allow the action itself", async () => {
    const env = setup({ access: teamAccess() });
    const result = await env.gateway.perform(ownerAgent(), {
      action: "project.delete",
      projectId: PROJECT,
      payload: {},
      summary: null,
    });
    if (result.outcome !== "approval_required") throw new Error("expected a pending request");
    // An editor has approvals.decide but not project.delete.
    await expect(
      env.approvals.approve(dashboardActor(EDITOR), result.pending.id, { confirmation: "Acme" }),
    ).rejects.toMatchObject({ reason: "forbidden" });
    expect(env.fakes.deleteProject).not.toHaveBeenCalled();
    await expect(env.approvals.reject(dashboardActor(EDITOR), result.pending.id)).resolves.toMatchObject({
      status: "rejected",
    });
  });

  it("lets the requester approve their own agent's request by default (spec §12 q2)", async () => {
    const env = setup({ access: teamAccess() });
    const requestId = await editorRequest(env);
    await expect(env.approvals.approve(dashboardActor(EDITOR), requestId)).resolves.toMatchObject({ status: "completed" });
  });

  it("with require_other_decider, blocks the requester's approve but not another member's", async () => {
    const env = setup({ access: teamAccess() });
    await env.flags.setProjectFlags(PROJECT, { requireOtherDecider: true });
    const requestId = await editorRequest(env);
    await expect(env.approvals.approve(dashboardActor(EDITOR), requestId)).rejects.toBeInstanceOf(OtherDeciderRequiredError);
    expect(env.fakes.publish).not.toHaveBeenCalled();
    await expect(env.approvals.get(dashboardActor(OWNER), requestId)).resolves.toMatchObject({ status: "pending" });
    await expect(env.approvals.approve(dashboardActor(OWNER), requestId)).resolves.toMatchObject({ status: "completed" });
  });

  it("tells each viewer whether they may approve, with the approve path's rule", async () => {
    const env = setup({ access: teamAccess() });
    await env.flags.setProjectFlags(PROJECT, { requireOtherDecider: true });
    const requestId = await editorRequest(env);

    await expect(env.approvals.review(dashboardActor(EDITOR), requestId)).resolves.toMatchObject({
      status: "pending",
      viewer: { canApprove: false, reason: "other_decider_required", canReject: true },
    });
    await expect(env.approvals.review(dashboardActor(VIEWER), requestId)).resolves.toMatchObject({
      viewer: { canApprove: false, reason: "missing_capability", canReject: false },
    });
    await expect(env.approvals.review(dashboardActor(OWNER), requestId)).resolves.toMatchObject({
      viewer: { canApprove: true, reason: null, canReject: true },
    });
  });

  it("lets the requester approve again in the detail once the rule is off", async () => {
    const env = setup({ access: teamAccess() });
    const requestId = await editorRequest(env);
    await expect(env.approvals.review(dashboardActor(EDITOR), requestId)).resolves.toMatchObject({
      viewer: { canApprove: true, reason: null, canReject: true },
    });
  });

  it("reports missing_capability when the role cannot run the action itself", async () => {
    const env = setup({ access: teamAccess() });
    const result = await env.gateway.perform(ownerAgent(), {
      action: "project.delete",
      projectId: PROJECT,
      payload: {},
      summary: null,
    });
    if (result.outcome !== "approval_required") throw new Error("expected a pending request");
    await expect(env.approvals.review(dashboardActor(EDITOR), result.pending.id)).resolves.toMatchObject({
      viewer: { canApprove: false, reason: "missing_capability", canReject: true },
    });
    await expect(env.approvals.review(dashboardActor(OWNER), result.pending.id)).resolves.toMatchObject({
      viewer: { canApprove: true, reason: null, canReject: true },
    });
  });

  it("with require_other_decider, still lets the requester reject or cancel", async () => {
    const env = setup({ access: teamAccess() });
    await env.flags.setProjectFlags(PROJECT, { requireOtherDecider: true });
    const rejected = await editorRequest(env);
    await expect(env.approvals.reject(dashboardActor(EDITOR), rejected)).resolves.toMatchObject({ status: "rejected" });
    const cancelled = await editorRequest(env);
    await expect(env.approvals.cancel(dashboardActor(EDITOR), cancelled)).resolves.toMatchObject({ status: "cancelled" });
  });

  // SECURITY REGRESSION GUARDRAIL (SEC-031): one member's agent never replaces or takes another member's request.
  it("never hands one member's pending request to another member's agent, and never replaces it", async () => {
    const env = setup({ access: teamAccess() });
    await env.flags.setProjectFlags(PROJECT, { requireOtherDecider: true });
    const ownerRequest = await pendingPublish(env);

    await expect(env.gateway.perform(editorAgent(), publishRequest)).rejects.toMatchObject({
      code: "pending_request_exists",
    });
    expect((await env.requests.findById(ownerRequest.pending.id as never))?.status).toBe("pending");
  });

  it("lets another member ask once a teammate's request is past its expiry", async () => {
    const env = setup({ access: teamAccess() });
    const ownerRequest = await pendingPublish(env);
    env.clock.now = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);

    const editorRequestId = await editorRequest(env);

    expect(editorRequestId).not.toBe(ownerRequest.pending.id);
    expect((await env.requests.findById(ownerRequest.pending.id as never))?.status).toBe("expired");
  });

  it("lets a member's own request wait for another decider", async () => {
    const env = setup({ access: teamAccess() });
    await env.flags.setProjectFlags(PROJECT, { requireOtherDecider: true });
    const editorRequestId = await editorRequest(env);

    await expect(env.approvals.get(editorAgent(), editorRequestId)).resolves.toMatchObject({ status: "pending" });
    await expect(env.approvals.approve(dashboardActor(EDITOR), editorRequestId)).rejects.toBeInstanceOf(
      OtherDeciderRequiredError,
    );
  });

  it("hides the requests from a member who left the team", async () => {
    const store = new InMemoryProjectAccess(
      { [PROJECT]: { owner: OWNER, teamId: TEAM } },
      { [TEAM]: { [OWNER]: "owner", [EDITOR]: "editor" } },
    );
    const env = setup({ access: new MembershipProjectAccessPolicy(store) });
    const requestId = await editorRequest(env);
    store.leave(TEAM, EDITOR);
    await expect(env.approvals.listForProject(dashboardActor(EDITOR), PROJECT)).rejects.toThrow("Approval request not found.");
    await expect(env.approvals.approve(dashboardActor(EDITOR), requestId)).rejects.toThrow("Approval request not found.");
    // The member's agent still holds its grant, but its own request reads as not found too.
    await expect(env.gateway.perform(editorAgent(), publishRequest)).rejects.toMatchObject({ reason: "not_found" });
    await expect(env.approvals.get(editorAgent(), requestId)).rejects.toThrow("Approval request not found.");
    await expect(env.approvals.listForAgent(editorAgent())).resolves.toEqual([]);
    await expect(env.approvals.cancel(editorAgent(), requestId)).rejects.toThrow("Approval request not found.");
    expect(env.requests.rows.get(requestId)?.status).toBe("pending");
  });

  it("shows the agent its own request again once its member rejoins", async () => {
    const store = new InMemoryProjectAccess(
      { [PROJECT]: { owner: OWNER, teamId: TEAM } },
      { [TEAM]: { [OWNER]: "owner", [EDITOR]: "editor" } },
    );
    const env = setup({ access: new MembershipProjectAccessPolicy(store) });
    const requestId = await editorRequest(env);
    await expect(env.approvals.listForAgent(editorAgent())).resolves.toHaveLength(1);
    store.leave(TEAM, EDITOR);
    store.join(TEAM, EDITOR, "viewer");
    // Any role keeps the agent's view of its own request; request tools need no scope.
    await expect(env.approvals.get(editorAgent(), requestId)).resolves.toMatchObject({ status: "pending" });
  });
});

describe("sweeper", () => {
  it("expires overdue requests and marks stale ones", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    const branch = env.fakes.state.branch;
    if (!branch) throw new Error("missing branch");
    env.fakes.state.branch = { ...branch, revision: 10 };
    const report = await env.sweeper.run();
    expect(report.stale).toBe(1);
    expect(env.requests.rows.get(pending.id)?.status).toBe("stale");
  });
});

describe("rpc handler", () => {
  const claims = {
    userId: "owner-1",
    clientId: "client-1",
    clientName: "Claude Code",
    grantRef: GRANT,
    scopes: ["publish"],
    projectScope: { kind: "all" as const },
  };

  it("answers with a value instead of throwing", async () => {
    const env = setup();
    const handler = new AgentActionsRpcHandler({ gateway: env.gateway, approvals: env.approvals, webOrigin: WEB_ORIGIN });
    const result = await handler.perform({ actor: claims, action: "docs.publish", projectId: PROJECT, payload: { branchId: BRANCH }, summary: null });
    expect(result).toMatchObject({ ok: true, value: { outcome: "approval_required" } });
  });

  it("maps a refusal to an error code", async () => {
    const env = setup();
    const handler = new AgentActionsRpcHandler({ gateway: env.gateway, approvals: env.approvals, webOrigin: WEB_ORIGIN });
    const result = await handler.perform({ actor: { ...claims, scopes: [] }, action: "docs.publish", projectId: PROJECT, payload: { branchId: BRANCH }, summary: null });
    expect(result).toEqual({ ok: false, error: { code: "scope_missing", message: expect.any(String) } });
  });

  it("maps a publish blocked by MDX issues to its code", async () => {
    const env = setup();
    env.fakes.state.mdxIssues = [
      { href: "/", sourcePath: "source/index.mdx", issues: [{ line: 3, column: 1, message: "Bad" }] },
    ];
    const handler = new AgentActionsRpcHandler({ gateway: env.gateway, approvals: env.approvals, webOrigin: WEB_ORIGIN });
    const result = await handler.perform({ actor: claims, action: "docs.publish", projectId: PROJECT, payload: { branchId: BRANCH }, summary: null });
    expect(result).toEqual({
      ok: false,
      error: { code: "mdx_invalid", message: expect.stringContaining("/ (source/index.mdx line 3): Bad") },
    });
  });

  it("serves a request with its approval link for MCP Tasks", async () => {
    const env = setup();
    const handler = new AgentActionsRpcHandler({ gateway: env.gateway, approvals: env.approvals, webOrigin: WEB_ORIGIN });
    const performed = await handler.perform({ actor: claims, action: "docs.publish", projectId: PROJECT, payload: { branchId: BRANCH }, summary: null });
    if (!performed.ok || performed.value.outcome !== "approval_required") throw new Error("Expected a gated publish.");
    const { pending } = performed.value;
    const result = await handler.getRequestTask({ actor: claims, requestId: pending.id });
    expect(result).toEqual({
      ok: true,
      value: { request: expect.objectContaining({ id: pending.id, status: "pending" }), approvalUrl: pending.approvalUrl },
    });
    const otherClient = await handler.getRequestTask({ actor: { ...claims, clientId: "client-2" }, requestId: pending.id });
    expect(otherClient).toMatchObject({ ok: false, error: { code: "request_not_found" } });
  });

  it("rejects an invalid input", async () => {
    const env = setup();
    const handler = new AgentActionsRpcHandler({ gateway: env.gateway, approvals: env.approvals, webOrigin: WEB_ORIGIN });
    const result = await handler.perform({ actor: claims, action: "unknown", projectId: PROJECT, payload: {}, summary: null });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("approval notifications", () => {
  it("announces a new request once, not when the agent repeats it", async () => {
    const env = setup();
    const { pending } = await pendingPublish(env);
    await env.gateway.perform(ownerAgent(), publishRequest);

    expect(env.notifier.requested).toHaveBeenCalledTimes(1);
    expect(env.notifier.requested.mock.calls[0]?.[0]).toMatchObject({ id: pending.id, status: "pending" });
  });

  it("tells the requester about an approval and a rejection", async () => {
    const env = setup();
    const first = await pendingPublish(env);
    await env.approvals.approve(ownerDashboard(), first.pending.id);
    expect(env.notifier.decided).toHaveBeenLastCalledWith(expect.objectContaining({ id: first.pending.id }), "approved");

    const second = await pendingPublish(env);
    await env.approvals.reject(ownerDashboard(), second.pending.id, "Not yet.");
    expect(env.notifier.decided).toHaveBeenLastCalledWith(expect.objectContaining({ id: second.pending.id }), "rejected");
  });
});
