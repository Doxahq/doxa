import { describe, expect, it, vi } from "vitest";
import { UnsubscribeTokens } from "@doxahq/email";
import type { ApprovalRequestRecord } from "../../../src/repositories/agent-approval-requests";
import type { EmailAudience, ProjectMember } from "../../../src/repositories/email-audience";
import { toApprovalRequestId } from "../../../src/services/agent-actions/approval-request-id";
import { AGENT_ACTIONS } from "../../../src/services/agent-actions/registry";
import { EmailOutbox } from "../../../src/services/email/email-outbox";
import { ApprovalEmailNotifications } from "../../../src/services/email/notifications/approval-notifications";
import { DomainEmailNotifications } from "../../../src/services/email/notifications/domain-notifications";
import { GenerationEmailNotifications } from "../../../src/services/email/notifications/generation-notifications";
import { NotificationOutbox } from "../../../src/services/email/notifications/notification-outbox";
import { InMemoryEmailStore, RecordingEmailQueue } from "../../support/in-memory-email-store";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const links = { webOrigin: "https://doxa.so", apiOrigin: "https://api.doxa.so" };

const member = (userId: string, role: ProjectMember["role"]): ProjectMember => ({
  userId,
  name: userId,
  email: `${userId}@example.com`,
  role,
});

const MEMBERS = [member("owner", "owner"), member("admin", "admin"), member("editor", "editor"), member("viewer", "viewer")];

function setup(options: { requireOtherDecider?: boolean; requester?: boolean } = {}) {
  const store = new InMemoryEmailStore();
  const outbox = new EmailOutbox({
    deliveries: store,
    preferences: store,
    queue: new RecordingEmailQueue(),
    unsubscribe: new UnsubscribeTokens("x".repeat(32)),
    links,
    log: vi.fn(),
  });
  const audience: EmailAudience = {
    projectAudience: async (projectId) => (projectId === PROJECT ? { projectName: "Engines Docs", members: MEMBERS } : null),
    contactsFor: async (ids) => new Map(MEMBERS.filter((m) => ids.includes(m.userId)).map((m) => [m.userId, m])),
    generationAudience: async () => ({
      projectId: PROJECT,
      projectName: "Engines Docs",
      requester: options.requester === false ? null : member("editor", "editor"),
    }),
  };
  const log = vi.fn();
  const notifications = new NotificationOutbox(outbox, log);
  const pending: Promise<unknown>[] = [];
  const approvals = new ApprovalEmailNotifications({
    registry: AGENT_ACTIONS,
    audience,
    flags: {
      projectFlags: async () => ({ eraseBranchAfterPublish: false, requireOtherDecider: options.requireOtherDecider ?? false }),
    },
    notifications,
    links,
    defer: (work) => pending.push(work),
  });
  const settle = () => Promise.all(pending);
  const recipients = () => store.deliveries.map((row) => row.recipientEmail).sort();
  return { store, audience, notifications, approvals, settle, recipients, log };
}

function request(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  const now = new Date("2026-10-07T12:00:00Z");
  return {
    id: toApprovalRequestId("aaaaaaaa-0000-4000-8000-000000000001"),
    projectId: PROJECT,
    actionKind: "docs.publish",
    targetKey: "branch-1",
    status: "pending",
    payloadVersion: 1,
    payload: {},
    snapshot: {},
    summary: null,
    result: null,
    error: null,
    requestedByUserId: "editor",
    requestedByClientId: "client-1",
    requestedByClientName: "Claude Code",
    grantRef: "grant-1",
    decidedByUserId: null,
    decisionNote: null,
    policySource: "default",
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
    completedAt: null,
    expiresAt: now,
    ...overrides,
  };
}

describe("approval-requested", () => {
  it("goes to every member who can approve the action", async () => {
    const env = setup();
    env.approvals.requested(request());
    await env.settle();

    // docs.publish needs approvals.decide and docs.publish: the viewer has neither.
    expect(env.recipients()).toEqual(["admin@example.com", "editor@example.com", "owner@example.com"]);
    expect(env.store.deliveries[0]?.props).toMatchObject({
      projectName: "Engines Docs",
      agentName: "Claude Code",
      requesterName: "editor",
      reviewUrl: "https://doxa.so/approve/aaaaaaaa-0000-4000-8000-000000000001",
    });
  });

  it("leaves out the requester when the project requires another decider", async () => {
    const env = setup({ requireOtherDecider: true });
    env.approvals.requested(request());
    await env.settle();

    expect(env.recipients()).toEqual(["admin@example.com", "owner@example.com"]);
  });

  it("only the owner can approve a project delete", async () => {
    const env = setup();
    env.approvals.requested(request({ actionKind: "project.delete" }));
    await env.settle();

    expect(env.recipients()).toEqual(["owner@example.com"]);
  });
});

describe("approval-decided", () => {
  it("tells the requester who decided", async () => {
    const env = setup();
    env.approvals.decided(request({ status: "rejected", decidedByUserId: "admin" }), "rejected");
    await env.settle();

    expect(env.recipients()).toEqual(["editor@example.com"]);
    expect(env.store.deliveries[0]?.props).toMatchObject({ decision: "rejected", deciderName: "admin" });
  });

  it("sends nothing when the requester decided", async () => {
    const env = setup();
    env.approvals.decided(request({ decidedByUserId: "editor" }), "approved");
    await env.settle();

    expect(env.store.deliveries).toHaveLength(0);
  });
});

describe("generation-finished", () => {
  it("tells the member who started it, once for each job", async () => {
    const env = setup();
    const generations = new GenerationEmailNotifications({ ...env, links });

    await generations.finished("job-1", "failed", "  The repository was empty.  ");
    await generations.finished("job-1", "succeeded");

    expect(env.recipients()).toEqual(["editor@example.com"]);
    expect(env.store.deliveries[0]?.props).toMatchObject({
      outcome: "failed",
      failureReason: "The repository was empty.",
      generationUrl: `https://doxa.so/dashboard/projects/${PROJECT}/generations/job-1`,
    });
  });

  it("sends nothing for a run without a known requester", async () => {
    const env = setup({ requester: false });
    await new GenerationEmailNotifications({ ...env, links }).finished("job-1", "succeeded");

    expect(env.store.deliveries).toHaveLength(0);
  });

  it("logs a failure instead of throwing it", async () => {
    const env = setup();
    const broken = new GenerationEmailNotifications({
      audience: { generationAudience: async () => Promise.reject(new Error("database down")) },
      notifications: env.notifications,
      links,
    });

    await expect(broken.finished("job-1", "succeeded")).resolves.toBeUndefined();
    expect(env.log).toHaveBeenCalledWith("email_notification_failed", expect.objectContaining({ notification: "generation-finished" }));
  });
});

describe("domain-status-changed", () => {
  it("goes to the members who manage domains", async () => {
    const env = setup();
    await new DomainEmailNotifications({ ...env, links }).statusChanged({
      projectId: PROJECT,
      domainId: "domain-1",
      hostname: "docs.example.com",
      status: "active",
      failureReason: null,
      changedAt: new Date("2026-10-07T12:00:00Z"),
    });

    expect(env.recipients()).toEqual(["admin@example.com", "owner@example.com"]);
  });
});
