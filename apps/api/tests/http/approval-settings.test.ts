import { describe, expect, test, vi } from "vitest";
import { projectApprovalSettingsSchema, userApprovalSettingsSchema } from "@doxahq/contracts/approval-settings";
import { createApiRouter } from "../../src/http/app";
import type { ActionAccessPolicy } from "../../src/services/agent-actions/action-access";
import { ApprovalSettingsService } from "../../src/services/agent-actions/approval-settings-service";
import { approvalPolicyFor } from "../../src/services/agent-actions/policy/policy-sources";
import { AGENT_ACTIONS } from "../../src/services/agent-actions/registry";
import { InMemoryApprovalSettingsStore } from "../support/in-memory-approval-settings";
import { fakeAccess, OWNER, PROJECT, STRANGER } from "../services/agent-actions/fakes";

const session = vi.hoisted(() => ({ userId: "owner-1" }));
vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(session.userId),
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import {
  createProjectApprovalSettingsRoutes,
  createUserApprovalSettingsRoutes,
} from "../../src/routes/approval-settings";

const PATH = `/projects/${PROJECT}/approval-settings`;

function setup(access: ActionAccessPolicy = fakeAccess()) {
  session.userId = OWNER;
  const store = new InMemoryApprovalSettingsStore([PROJECT]);
  const settings = new ApprovalSettingsService({
    registry: AGENT_ACTIONS,
    access,
    store,
    policyFor: (modes) => approvalPolicyFor(AGENT_ACTIONS, modes),
    activity: { append: async () => undefined },
    now: () => new Date("2026-10-05T12:00:00Z"),
  });
  const app = createApiRouter();
  app.route("/projects/:projectId/approval-settings", createProjectApprovalSettingsRoutes(() => settings));
  app.route("/approval-settings", createUserApprovalSettingsRoutes(() => settings));
  return { app, store };
}

const put = (body: unknown) => ({ method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("project approval settings routes", () => {
  test("returns the settings in the contract shape", async () => {
    const { app } = setup();
    const response = await app.request(PATH);
    expect(response.status).toBe(200);
    const body = projectApprovalSettingsSchema.parse(await response.json());
    expect(body).toMatchObject({ projectId: PROJECT, canConfigure: true, eraseBranchAfterPublish: true });
  });

  test("saves modes and the erase default", async () => {
    const { app, store } = setup();
    const response = await app.request(PATH, put({ modes: { "docs.publish": "allow" }, eraseBranchAfterPublish: false }));
    expect(response.status).toBe(200);
    const body = projectApprovalSettingsSchema.parse(await response.json());
    expect(body.eraseBranchAfterPublish).toBe(false);
    expect(body.actions.find((action) => action.actionKind === "docs.publish")).toMatchObject({
      mode: "allow",
      effectiveMode: "allow",
      effectiveSource: "project_setting",
    });
    expect(await store.findMode({ kind: "project", projectId: PROJECT }, "docs.publish")).toBe("allow");
  });

  test.each([
    ["a mode outside allowedModes", { modes: { "project.delete": "allow" } }],
    ["an unknown mode", { modes: { "docs.publish": "sometimes" } }],
    ["an unknown field", { modes: {}, teamId: "x" }],
    ["invalid JSON", "{not json"],
  ])("answers 400 for %s", async (_name, body) => {
    const { app } = setup();
    expect((await app.request(PATH, put(body))).status).toBe(400);
  });

  test("answers 404 to a user without access", async () => {
    const { app } = setup();
    session.userId = STRANGER;
    expect((await app.request(PATH)).status).toBe(404);
    expect((await app.request(PATH, put({ modes: { "docs.publish": "allow" } }))).status).toBe(404);
  });

  test("answers 403 to a member without approvals.configure", async () => {
    const owner = fakeAccess();
    const { app } = setup({
      authorize: async (actor, projectId, capability) =>
        capability === "approvals.configure"
          ? { allowed: false, reason: "forbidden" }
          : owner.authorize(actor, projectId, capability),
    });
    const read = projectApprovalSettingsSchema.parse(await (await app.request(PATH)).json());
    expect(read.canConfigure).toBe(false);
    const response = await app.request(PATH, put({ modes: { "docs.publish": "allow" } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { details: { code: "forbidden" } } });
  });
});

describe("user approval settings routes", () => {
  test("reads and saves the user defaults", async () => {
    const { app, store } = setup();
    const before = userApprovalSettingsSchema.parse(await (await app.request("/approval-settings")).json());
    expect(before.actions.map((action) => action.actionKind)).toContain("project.create");
    const response = await app.request("/approval-settings", put({ modes: { "project.create": "require_approval" } }));
    expect(response.status).toBe(200);
    expect(await store.findMode({ kind: "user", userId: OWNER }, "project.create")).toBe("require_approval");
  });

  test("answers 400 for a mode outside allowedModes", async () => {
    const { app } = setup();
    expect((await app.request("/approval-settings", put({ modes: { "project.delete": "allow" } }))).status).toBe(400);
  });
});
