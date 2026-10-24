import { dashboardApprovalRequestSchema } from "@doxahq/contracts/approval-requests";
import { SILENT_APPROVAL_NOTIFIER } from "../../src/services/agent-actions/approval-notifier";
import { describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { ApprovalService } from "../../src/services/agent-actions/approval-service";
import { AgentActionGateway } from "../../src/services/agent-actions/gateway";
import { ApprovalPolicyResolver } from "../../src/services/agent-actions/policy/approval-policy";
import { AGENT_ACTIONS } from "../../src/services/agent-actions/registry";
import { InMemoryAgentApprovalRequestStore } from "../support/in-memory-agent-approval-requests";
import { InMemoryApprovalSettingsStore } from "../support/in-memory-approval-settings";
import { BRANCH, fakeAccess, fakeServices, ownerAgent, OWNER, PROJECT } from "../services/agent-actions/fakes";

const session = vi.hoisted(() => ({ userId: "owner-1" }));
vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(session.userId),
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import {
  createApprovalRequestLinkRoutes,
  createProjectApprovalRequestRoutes,
} from "../../src/routes/approval-requests";

const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";

async function setup() {
  session.userId = OWNER;
  const requests = new InMemoryAgentApprovalRequestStore();
  const fakes = fakeServices();
  const access = fakeAccess({ [PROJECT]: OWNER, [OTHER_PROJECT]: OWNER });
  const deps = {
    registry: AGENT_ACTIONS,
    requests,
    access,
    services: fakes.services,
    now: () => new Date(),
    notifier: SILENT_APPROVAL_NOTIFIER,
  };
  const flags = new InMemoryApprovalSettingsStore([PROJECT, OTHER_PROJECT]);
  const approvals = new ApprovalService({
    ...deps,
    activity: { append: async () => undefined },
    flags,
    users: { namesFor: async () => new Map([[OWNER, "Olivia Owner"]]) },
    defer: () => undefined,
  });
  const gateway = new AgentActionGateway({
    ...deps,
    policy: new ApprovalPolicyResolver([], AGENT_ACTIONS.rulesFor),
    webOrigin: "https://doxa.so",
  });
  const result = await gateway.perform(ownerAgent(), {
    action: "docs.publish",
    projectId: PROJECT,
    payload: { branchId: BRANCH },
    summary: null,
  });
  if (result.outcome !== "approval_required") throw new Error("expected a pending request");
  const app = createApiRouter();
  app.route("/approval-requests", createApprovalRequestLinkRoutes(() => approvals));
  app.route("/projects/:projectId/approval-requests", createProjectApprovalRequestRoutes(() => approvals));
  return { app, requestId: result.pending.id, fakes, flags };
}

describe("approval request routes", () => {
  test("resolves the web link to the publish menu", async () => {
    const { app, requestId } = await setup();
    const response = await app.request(`/approval-requests/${requestId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId: PROJECT,
      reviewSurface: { kind: "publish_menu" },
      branchId: BRANCH,
    });
  });

  test("answers 404 for another user's request and for a malformed ID", async () => {
    const { app, requestId } = await setup();
    session.userId = "stranger-1";
    expect((await app.request(`/approval-requests/${requestId}`)).status).toBe(404);
    expect((await app.request("/approval-requests/not-a-uuid")).status).toBe(404);
  });

  test("answers 404 when the path names another project", async () => {
    const { app, requestId } = await setup();
    const response = await app.request(`/projects/${OTHER_PROJECT}/approval-requests/${requestId}/approve`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  test("approves once, then answers 409", async () => {
    const { app, requestId, fakes } = await setup();
    const path = `/projects/${PROJECT}/approval-requests/${requestId}/approve`;
    const first = await app.request(path, { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "completed" });
    const second = await app.request(path, { method: "POST" });
    expect(second.status).toBe(409);
    expect(fakes.publish).toHaveBeenCalledOnce();
  });

  test("streams publish stages as server-sent events", async () => {
    const { app, requestId } = await setup();
    const response = await app.request(`/projects/${PROJECT}/approval-requests/${requestId}/approve`, {
      method: "POST",
      headers: { accept: "text/event-stream" },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("event: result");
  });

  test("rejects with a reason and lists the request", async () => {
    const { app, requestId } = await setup();
    const reject = await app.request(`/projects/${PROJECT}/approval-requests/${requestId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "Not yet." }),
    });
    expect(await reject.json()).toMatchObject({ status: "rejected", decisionNote: "Not yet." });
    const list = await app.request(`/projects/${PROJECT}/approval-requests?status=rejected`);
    expect(await list.json()).toMatchObject({ requests: [{ id: requestId }] });
  });

  test("answers 400 for an invalid body", async () => {
    const { app, requestId } = await setup();
    const response = await app.request(`/projects/${PROJECT}/approval-requests/${requestId}/reject`, {
      method: "POST",
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  test("answers 403 other_decider_required when the requester approves their own agent's request", async () => {
    const { app, requestId, flags, fakes } = await setup();
    await flags.setProjectFlags(PROJECT, { requireOtherDecider: true });
    const response = await app.request(`/projects/${PROJECT}/approval-requests/${requestId}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { details: { code: "other_decider_required" } } });
    expect(fakes.publish).not.toHaveBeenCalled();
  });

  test("returns the viewer's approve permission with the detail", async () => {
    const { app, requestId, flags } = await setup();
    const path = `/projects/${PROJECT}/approval-requests/${requestId}`;
    const open = await app.request(path);
    expect(dashboardApprovalRequestSchema.parse(await open.json()).viewer).toEqual({ canApprove: true, reason: null, canReject: true });

    await flags.setProjectFlags(PROJECT, { requireOtherDecider: true });
    const blocked = await app.request(path);
    expect(dashboardApprovalRequestSchema.parse(await blocked.json()).viewer).toEqual({
      canApprove: false,
      reason: "other_decider_required",
      canReject: true,
    });
  });

  test("returns the viewer with the reject result", async () => {
    const { app, requestId } = await setup();
    const reject = await app.request(`/projects/${PROJECT}/approval-requests/${requestId}/reject`, { method: "POST" });
    const body = dashboardApprovalRequestSchema.parse(await reject.json());
    expect(body).toMatchObject({ status: "rejected", viewer: { canApprove: true } });
  });

  test("names the member who asked", async () => {
    const { app } = await setup();
    const response = await app.request(`/projects/${PROJECT}/approval-requests`);
    const body = (await response.json()) as { requests: { requestedBy: unknown }[] };
    expect(body.requests[0]?.requestedBy).toEqual({ userId: OWNER, name: "Olivia Owner", clientName: "Claude Code" });
  });
});
