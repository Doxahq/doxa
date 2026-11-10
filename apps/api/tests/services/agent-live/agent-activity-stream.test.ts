import type { AgentLiveEvent } from "@doxahq/contracts/agent-live-activity";
import { describe, expect, it, vi } from "vitest";
import {
  createStreamSlots,
  MAX_STREAM_DURATION_MS,
  streamAgentActivity,
  type ActivityStreamWriter,
  type AgentActivityFeed,
} from "../../../src/services/agent-live/agent-activity-stream";

const T0 = Date.parse("2026-11-09T12:00:00.000Z");
const ISO = new Date(T0).toISOString();

function event(seq: number, occurredAt = ISO): AgentLiveEvent {
  return {
    seq,
    occurredAt,
    branchId: null,
    grantRef: "grant-1",
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
  };
}

interface Harness {
  batches: AgentLiveEvent[][];
  latestSeq?: number;
  events?: AgentLiveEvent[];
  sleepsBeforeAbort?: number;
}

function run(harness: Harness) {
  let time = T0;
  const written: { type: string; id?: string }[] = [];
  const sleeps: number[] = [];
  const stream: ActivityStreamWriter = {
    aborted: false,
    writeSSE: async ({ event: type, id }) => void written.push({ type, id }),
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
      if (sleeps.length >= (harness.sleepsBeforeAbort ?? Number.POSITIVE_INFINITY)) {
        (stream as { aborted: boolean }).aborted = true;
      }
    },
  };
  const afterCalls: number[] = [];
  const feed: AgentActivityFeed = {
    snapshot: async () => ({
      agents: [],
      events: harness.events ?? [],
      latestSeq: harness.latestSeq ?? 0,
      serverTime: ISO,
    }),
    presence: async () => ({ agents: [], serverTime: ISO }),
    eventsAfter: async (_projectId, afterSeq) => {
      afterCalls.push(afterSeq);
      return harness.batches.shift() ?? [];
    },
  };
  const finished = streamAgentActivity({ stream, feed, projectId: "p", viewerUserId: "u", now: () => time });
  return { finished, written, sleeps, afterCalls };
}

describe("streamAgentActivity", () => {
  it("sends the snapshot, then events in order with their IDs, then presence", async () => {
    const { finished, written, afterCalls } = run({
      batches: [[event(4), event(5)]],
      latestSeq: 3,
      sleepsBeforeAbort: 1,
    });
    await finished;
    expect(written).toEqual([
      { type: "snapshot", id: undefined },
      { type: "event", id: "4" },
      { type: "event", id: "5" },
      { type: "presence", id: undefined },
    ]);
    expect(afterCalls).toEqual([3]);
  });

  it("continues from the last event it sent", async () => {
    const { finished, afterCalls } = run({ batches: [[event(4)], []], latestSeq: 3, sleepsBeforeAbort: 2 });
    await finished;
    expect(afterCalls).toEqual([3, 4]);
  });

  it("polls fast after an event and slowly when nothing happens", async () => {
    const quiet = run({ batches: [], sleepsBeforeAbort: 2 });
    await quiet.finished;
    expect(quiet.sleeps).toEqual([5_000, 5_000]);
    const busy = run({ batches: [[event(1)]], sleepsBeforeAbort: 2 });
    await busy.finished;
    expect(busy.sleeps).toEqual([1_000, 1_000]);
  });

  it("sends presence as a heartbeat every 15 seconds", async () => {
    const { finished, written } = run({ batches: [], sleepsBeforeAbort: 4 });
    await finished;
    expect(written.filter(({ type }) => type === "presence")).toHaveLength(1);
  });

  it("ends by itself, so that a reconnect checks access again", async () => {
    const { finished, sleeps } = run({ batches: [] });
    await finished;
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(MAX_STREAM_DURATION_MS);
  });
});

describe("createStreamSlots", () => {
  it("limits each user and frees a slot once", () => {
    const slots = createStreamSlots(2);
    const first = slots.acquire("a");
    expect(slots.acquire("a")).not.toBeNull();
    expect(slots.acquire("a")).toBeNull();
    expect(slots.acquire("b")).not.toBeNull();
    first?.();
    first?.();
    expect(slots.acquire("a")).not.toBeNull();
    expect(slots.acquire("a")).toBeNull();
  });
});

vi.restoreAllMocks();
