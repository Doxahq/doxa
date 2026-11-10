import { agentPresence, cleanAgentText, isAgentLiveActivityEnabled } from "@doxahq/contracts/agent-live-activity";
import { describe, expect, it } from "vitest";
import type { AgentLiveEventRecord } from "../../../src/repositories/agent-live-events";
import { AgentActivityService, summarizeAgents } from "../../../src/services/agent-live/agent-activity-service";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

function record(seq: number, secondsAgo: number, overrides: Partial<AgentLiveEventRecord> = {}): AgentLiveEventRecord {
  return {
    projectId: "project-1",
    seq,
    occurredAt: ago(secondsAgo),
    branchId: null,
    userId: "owner",
    grantRef: "grant-1",
    clientId: "client-1",
    clientName: "Claude Code",
    tool: "read_page",
    kind: "read",
    pageHref: "/a",
    pageTitle: "A",
    detail: null,
    note: null,
    linesAdded: null,
    linesRemoved: null,
    branchRevision: null,
    hasDiff: false,
    ...overrides,
  };
}

const context = { pending: new Set<string>(), tokenNames: new Map<string, string>(), viewerUserId: "owner", now: NOW };

describe("agentPresence", () => {
  const at = (seconds: number, hasPendingApproval = false) =>
    agentPresence({ lastEventAt: ago(seconds), hasPendingApproval, now: NOW });

  it("follows the 60-second and 30-minute limits", () => {
    expect(at(59)).toBe("active");
    expect(at(60)).toBe("idle");
    expect(at(1800)).toBe("idle");
    expect(at(1801)).toBeNull();
  });

  it("puts a pending approval first, at any age", () => {
    expect(at(5, true)).toBe("waiting");
    expect(at(9999, true)).toBe("waiting");
  });
});

describe("the text and switch helpers", () => {
  it("only accepts the exact flag value", () => {
    expect(isAgentLiveActivityEnabled("true")).toBe(true);
    expect(isAgentLiveActivityEnabled("TRUE")).toBe(false);
    expect(isAgentLiveActivityEnabled(undefined)).toBe(false);
  });

  it("removes controls, and keeps text whole when it cuts", () => {
    expect(cleanAgentText("  a‮b\r\n\tc ")).toBe("ab c");
    expect(cleanAgentText("\u0007 \n")).toBeNull();
    expect(cleanAgentText("😀😀😀", 2)).toBe("😀😀");
  });
});

describe("summarizeAgents", () => {
  it("gives one row per grant, with presence and the session start", () => {
    const agents = summarizeAgents(
      [record(4, 10), record(3, 200, { grantRef: "grant-2", clientName: "Cursor", userId: "member" }), record(2, 600), record(1, 3000)],
      { ...context, tokenNames: new Map([["grant-1", "Acme docs"]]) },
    );
    expect(agents).toEqual([
      expect.objectContaining({
        grantRef: "grant-1",
        tokenName: "Acme docs",
        presence: "active",
        startedAt: ago(600).toISOString(),
        canRevoke: true,
      }),
      expect.objectContaining({ grantRef: "grant-2", presence: "idle", tokenName: null, canRevoke: false }),
    ]);
  });

  it("leaves out an agent after 30 minutes, unless it waits for a person", () => {
    expect(summarizeAgents([record(1, 4000)], context)).toEqual([]);
    expect(summarizeAgents([record(1, 4000)], { ...context, pending: new Set(["grant-1"]) })).toEqual([
      expect.objectContaining({ presence: "waiting" }),
    ]);
  });
});

describe("AgentActivityService", () => {
  function service(records: AgentLiveEventRecord[]) {
    return new AgentActivityService({
      reader: {
        listRecent: async () => records,
        pendingApprovalGrantRefs: async () => new Set(),
        tokenNamesByGrantRef: async () => new Map(),
        listAfter: async () => [],
        findDiff: async () => "+line",
      },
      now: () => NOW,
    });
  }

  it("never sends the user ID in the snapshot", async () => {
    const snapshot = await service([record(1, 5)]).snapshot("project-1", "owner");
    expect(snapshot.events[0]).not.toHaveProperty("userId");
    expect(snapshot.latestSeq).toBe(1);
  });

  it("marks an event that has a diff, and returns the diff only on request", async () => {
    const reader = service([record(1, 5, { hasDiff: true, linesAdded: 1, linesRemoved: 0, note: "Why" })]);
    const snapshot = await reader.snapshot("project-1", "owner");
    expect(snapshot.events[0]).toMatchObject({ hasDiff: true, linesAdded: 1, linesRemoved: 0, note: "Why" });
    expect(await reader.diff("project-1", 1)).toBe("+line");
  });

  it("does not count a person's decision as agent activity", async () => {
    const agents = summarizeAgents(
      [record(2, 5, { tool: "approval_decision", kind: "approval" }), record(1, 200)],
      context,
    );
    expect(agents).toEqual([expect.objectContaining({ presence: "idle", lastEventAt: ago(200).toISOString() })]);
  });

  it("skips a row with an unknown kind", async () => {
    const snapshot = await service([record(2, 5, { kind: "future" }), record(1, 6)]).snapshot("project-1", "owner");
    expect(snapshot.events.map((event) => event.seq)).toEqual([1]);
    expect(snapshot.latestSeq).toBe(2);
  });
});
