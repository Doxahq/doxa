import { describe, expect, it, vi } from "vitest";
import { SILENT_APPROVAL_NOTIFIER } from "../../../src/services/agent-actions/approval-notifier";
import { dashboardActor, toProjectId } from "../../../src/services/agent-access/actor";
import type { ActionAccessPolicy } from "../../../src/services/agent-actions/action-access";
import { approvalPolicyFor } from "../../../src/services/agent-actions/policy/policy-sources";
import { ApprovalSettingsService } from "../../../src/services/agent-actions/approval-settings-service";
import { ApprovalSweeper } from "../../../src/services/agent-actions/approval-sweeper";
import {
  ActionAccessDeniedError,
  ActionDeniedError,
  ApprovalSettingInvalidError,
} from "../../../src/services/agent-actions/errors";
import { AgentActionGateway } from "../../../src/services/agent-actions/gateway";
import { ApprovalPolicyResolver } from "../../../src/services/agent-actions/policy/approval-policy";
import { PlatformOverrideSource } from "../../../src/services/agent-actions/policy/platform-overrides";
import { ProjectSettingSource, UserSettingSource } from "../../../src/services/agent-actions/policy/setting-sources";
import { AGENT_ACTIONS } from "../../../src/services/agent-actions/registry";
import type { AgentActivityRecord } from "../../../src/repositories/agent-activity";
import { InMemoryAgentApprovalRequestStore } from "../../support/in-memory-agent-approval-requests";
import { membershipPolicy } from "../../support/in-memory-project-access";
import { InMemoryApprovalSettingsStore } from "../../support/in-memory-approval-settings";
import { BRANCH, fakeAccess, fakeServices, OWNER, ownerAgent, ownerDashboard, PROJECT, STRANGER } from "./fakes";

const NOW = new Date("2026-10-05T12:00:00Z");
const OTHER_PROJECT = "77777777-7777-4777-8777-777777777777";
const MEMBER = "member-1";
const projectScope = { kind: "project", projectId: PROJECT } as const;
const otherProjectScope = { kind: "project", projectId: OTHER_PROJECT } as const;
const userScope = { kind: "user", userId: OWNER } as const;

function setup() {
  const store = new InMemoryApprovalSettingsStore([PROJECT, OTHER_PROJECT]);
  const requests = new InMemoryAgentApprovalRequestStore();
  const fakes = fakeServices();
  const access = fakeAccess({ [PROJECT]: OWNER, [OTHER_PROJECT]: OWNER });
  const policy = approvalPolicyFor(AGENT_ACTIONS, store);
  const activity: AgentActivityRecord[] = [];
  const now = () => NOW;
  const deps = { registry: AGENT_ACTIONS, requests, access, services: fakes.services, now };
  const gateway = new AgentActionGateway({ ...deps, policy, webOrigin: "https://doxa.so", notifier: SILENT_APPROVAL_NOTIFIER });
  const sweeper = new ApprovalSweeper({ ...deps, policy });
  const settings = new ApprovalSettingsService({
    registry: AGENT_ACTIONS,
    access,
    store,
    policyFor: (modes) => approvalPolicyFor(AGENT_ACTIONS, modes),
    activity: { append: async (record) => void activity.push(record) },
    now,
  });
  return { store, requests, gateway, sweeper, settings, activity, fakes };
}

const publishIn = (projectId: string) => ({
  action: "docs.publish" as const,
  projectId,
  payload: { branchId: BRANCH },
  summary: null,
});

async function pendingPublish(env: ReturnType<typeof setup>, projectId = PROJECT) {
  const result = await env.gateway.perform(ownerAgent(), publishIn(projectId));
  if (result.outcome !== "approval_required") throw new Error("expected a pending request");
  return result.pending.id;
}

describe("policy sources", () => {
  const resolve = (env: ReturnType<typeof setup>, action: "docs.publish" | "project.delete" | "project.create", projectId: string | null) =>
    approvalPolicyFor(AGENT_ACTIONS, env.store).resolve({
      actor: ownerAgent(),
      projectId: projectId === null ? null : toProjectId(projectId),
      action,
    });

  it("uses the user setting where the project has none", async () => {
    const env = setup();
    env.store.seed(userScope, "docs.publish", "allow");
    await expect(resolve(env, "docs.publish", PROJECT)).resolves.toEqual({ mode: "allow", source: "user_setting" });
  });

  it("lets the project setting win over the user setting", async () => {
    const env = setup();
    env.store.seed(userScope, "docs.publish", "allow");
    env.store.seed(projectScope, "docs.publish", "require_approval");
    await expect(resolve(env, "docs.publish", PROJECT)).resolves.toEqual({
      mode: "require_approval",
      source: "project_setting",
    });
  });

  it("puts platform overrides first", async () => {
    const env = setup();
    env.store.seed(projectScope, "docs.publish", "deny");
    const resolver = new ApprovalPolicyResolver(
      [
        new PlatformOverrideSource([{ action: "docs.publish", target: { kind: "user", userId: OWNER }, mode: "allow" }]),
        new ProjectSettingSource(env.store),
        new UserSettingSource(env.store),
      ],
      AGENT_ACTIONS.rulesFor,
    );
    await expect(
      resolver.resolve({ actor: ownerAgent(), projectId: toProjectId(PROJECT), action: "docs.publish" }),
    ).resolves.toEqual({ mode: "allow", source: "platform_override" });
  });

  it("falls back to the action default", async () => {
    await expect(resolve(setup(), "docs.publish", PROJECT)).resolves.toEqual({
      mode: "require_approval",
      source: "action_default",
    });
  });

  it("ignores a stored mode outside allowedModes and asks the next source", async () => {
    const env = setup();
    env.store.seed(projectScope, "project.delete", "allow");
    env.store.seed(userScope, "project.delete", "deny");
    await expect(resolve(env, "project.delete", PROJECT)).resolves.toEqual({ mode: "deny", source: "user_setting" });
  });

  it("applies only the user setting to project.create", async () => {
    const env = setup();
    env.store.seed(userScope, "project.create", "require_approval");
    await expect(resolve(env, "project.create", null)).resolves.toEqual({
      mode: "require_approval",
      source: "user_setting",
    });
  });
});

describe("gateway with settings", () => {
  it("blocks an action that the project setting denies", async () => {
    const env = setup();
    env.store.seed(projectScope, "docs.publish", "deny");
    const attempt = env.gateway.perform(ownerAgent(), publishIn(PROJECT));
    await expect(attempt).rejects.toBeInstanceOf(ActionDeniedError);
    await expect(attempt).rejects.toMatchObject({ policySource: "project_setting" });
  });

  it("runs an action that the user setting allows and keeps the source on the request row", async () => {
    const env = setup();
    env.store.seed(userScope, "docs.publish", "allow");
    await expect(env.gateway.perform(ownerAgent(), publishIn(PROJECT))).resolves.toMatchObject({
      outcome: "completed",
      policySource: "user_setting",
    });
    env.store.seed(projectScope, "docs.publish", "require_approval");
    const requestId = await pendingPublish(env);
    expect(env.requests.rows.get(requestId)?.policySource).toBe("project_setting");
  });
});

describe("settings changes and pending requests", () => {
  it("keeps a pending request pending when the action is set to Allow", async () => {
    const env = setup();
    const requestId = await pendingPublish(env);
    await env.settings.updateProject(ownerDashboard(), PROJECT, { modes: { "docs.publish": "allow" } });
    await env.sweeper.run();
    expect(env.requests.rows.get(requestId)?.status).toBe("pending");
  });

  it("cancels pending requests of an action that the project blocks", async () => {
    const env = setup();
    const blocked = await pendingPublish(env);
    const elsewhere = await pendingPublish(env, OTHER_PROJECT);
    await env.settings.updateProject(ownerDashboard(), PROJECT, { modes: { "docs.publish": "deny" } });
    const report = await env.sweeper.run();
    expect(report.blocked).toBe(1);
    expect(env.requests.rows.get(blocked)).toMatchObject({
      status: "cancelled",
      decidedByUserId: null,
      error: { code: "blocked", message: "Blocked by a project setting." },
    });
    expect(env.requests.rows.get(elsewhere)?.status).toBe("pending");
  });

  it("cancels every blocked request, past the first page of pending requests", async () => {
    const env = setup();
    const total = 250;
    for (let index = 0; index < total; index += 1) {
      // One timestamp for all rows, so the page cursor falls back to the id.
      await env.requests.insertPending(
        {
          projectId: PROJECT,
          actionKind: "docs.publish",
          targetKey: `branch:${index}`,
          payloadVersion: 1,
          payload: { branchId: BRANCH },
          snapshot: null,
          summary: null,
          requestedByUserId: OWNER,
          requestedByClientId: "client-1",
          requestedByClientName: "Claude Code",
          grantRef: "grant-1",
          policySource: "action_default",
          expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        },
        () => false,
        NOW,
      );
    }
    await env.settings.updateProject(ownerDashboard(), PROJECT, { modes: { "docs.publish": "deny" } });
    const report = await env.sweeper.run();
    expect(report.blocked).toBe(total);
    expect([...env.requests.rows.values()].filter((row) => row.status === "pending")).toHaveLength(0);
  });

  it("cancels the user's requests across projects, except where a project setting still asks", async () => {
    const env = setup();
    const overridden = await pendingPublish(env);
    const blocked = await pendingPublish(env, OTHER_PROJECT);
    env.store.seed(projectScope, "docs.publish", "require_approval");
    await env.settings.updateUser(ownerDashboard(), { modes: { "docs.publish": "deny" } });
    await env.sweeper.run();
    expect(env.requests.rows.get(overridden)?.status).toBe("pending");
    expect(env.requests.rows.get(blocked)).toMatchObject({
      status: "cancelled",
      error: { message: "Blocked by a user setting." },
    });
  });
});

describe("approval settings service", () => {
  it("lists every project action with its stored and effective mode", async () => {
    const env = setup();
    env.store.seed(userScope, "docs.restore", "allow");
    env.store.seed(projectScope, "project.delete", "allow");
    const view = await env.settings.getProject(ownerDashboard(), PROJECT);
    expect(view).toMatchObject({ projectId: PROJECT, canConfigure: true, eraseBranchAfterPublish: true });
    expect(view.actions.map((action) => action.actionKind)).not.toContain("project.create");
    expect(view.actions.find((action) => action.actionKind === "docs.restore")).toMatchObject({
      mode: null,
      effectiveMode: "allow",
      effectiveSource: "user_setting",
    });
    expect(view.actions.find((action) => action.actionKind === "project.delete")).toEqual({
      actionKind: "project.delete",
      title: "Delete a project",
      allowedModes: ["require_approval", "deny"],
      defaultMode: "require_approval",
      mode: null,
      effectiveMode: "require_approval",
      effectiveSource: "action_default",
    });
  });

  it("lists every action, project.create included, for the user", async () => {
    const view = await setup().settings.getUser(ownerDashboard());
    expect(view.actions.map((action) => action.actionKind)).toEqual(AGENT_ACTIONS.kinds);
  });

  it("refuses a mode outside allowedModes and an action the scope cannot set", async () => {
    const env = setup();
    await expect(
      env.settings.updateProject(ownerDashboard(), PROJECT, { modes: { "project.delete": "allow" } }),
    ).rejects.toBeInstanceOf(ApprovalSettingInvalidError);
    await expect(
      env.settings.updateProject(ownerDashboard(), PROJECT, { modes: { "project.create": "deny" } }),
    ).rejects.toBeInstanceOf(ApprovalSettingInvalidError);
    expect(env.store.modes.size).toBe(0);
  });

  it("writes one activity row with the old and the new value for each real change", async () => {
    const env = setup();
    await env.settings.updateProject(ownerDashboard(), PROJECT, {
      modes: { "docs.publish": "allow", "docs.restore": null },
      eraseBranchAfterPublish: false,
    });
    await env.settings.updateProject(ownerDashboard(), PROJECT, { modes: { "docs.publish": "deny" } });
    expect(env.activity.map((row) => row.details)).toEqual([
      { kind: "approval_mode", scope: "project", actionKind: "docs.publish", from: null, to: "allow" },
      { kind: "erase_branch_after_publish", from: true, to: false },
      { kind: "approval_mode", scope: "project", actionKind: "docs.publish", from: "allow", to: "deny" },
    ]);
    expect(env.activity[0]).toMatchObject({
      userId: OWNER,
      projectId: PROJECT,
      clientId: "dashboard",
      tool: "update_approval_settings",
      actionKind: "docs.publish",
      outcome: "succeeded",
    });
    await expect(env.settings.getProject(ownerDashboard(), PROJECT)).resolves.toMatchObject({
      eraseBranchAfterPublish: false,
    });
  });

  it("stores require_other_decider, defaults it to false, and records the change", async () => {
    const env = setup();
    await expect(env.settings.getProject(ownerDashboard(), PROJECT)).resolves.toMatchObject({
      requireOtherDecider: false,
    });
    const view = await env.settings.updateProject(ownerDashboard(), PROJECT, { requireOtherDecider: true });
    expect(view.requireOtherDecider).toBe(true);
    // The erase default is untouched by a change of the other column.
    expect(view.eraseBranchAfterPublish).toBe(true);
    await env.settings.updateProject(ownerDashboard(), PROJECT, { requireOtherDecider: true });
    expect(env.activity.map((row) => row.details)).toEqual([{ kind: "require_other_decider", from: false, to: true }]);
  });

  it("writes a user-scope activity row without a project", async () => {
    const env = setup();
    await env.settings.updateUser(ownerDashboard(), { modes: { "project.create": "require_approval" } });
    expect(env.activity).toEqual([
      expect.objectContaining({
        projectId: null,
        details: { kind: "approval_mode", scope: "user", actionKind: "project.create", from: null, to: "require_approval" },
      }),
    ]);
  });

  it("answers not found to a stranger", async () => {
    const env = setup();
    await expect(env.settings.getProject(dashboardActor(STRANGER), PROJECT)).rejects.toMatchObject({ reason: "not_found" });
  });

  it("lets a member without approvals.configure read but not change the settings", async () => {
    const store = new InMemoryApprovalSettingsStore([PROJECT]);
    const settings = new ApprovalSettingsService({
      registry: AGENT_ACTIONS,
      access: memberAccess(),
      store,
      policyFor: (modes) => approvalPolicyFor(AGENT_ACTIONS, modes),
      activity: { append: vi.fn(async () => undefined) },
      now: () => NOW,
    });
    await expect(settings.getProject(dashboardActor(MEMBER), PROJECT)).resolves.toMatchObject({ canConfigure: false });
    const change = settings.updateProject(dashboardActor(MEMBER), PROJECT, { modes: { "docs.publish": "allow" } });
    await expect(change).rejects.toBeInstanceOf(ActionAccessDeniedError);
    await expect(change).rejects.toMatchObject({ reason: "forbidden" });
    expect(store.modes.size).toBe(0);
  });
});

/** A team editor: every capability of the page but `approvals.configure`. */
function memberAccess(): ActionAccessPolicy {
  return membershipPolicy(
    { [PROJECT]: { owner: OWNER, teamId: MEMBER_TEAM } },
    { [MEMBER_TEAM]: { [OWNER]: "owner", [MEMBER]: "editor" } },
  );
}

const MEMBER_TEAM = "77777777-7777-4777-8777-777777777777";
