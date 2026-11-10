import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/env";

const mocks = vi.hoisted(() => ({
  allowed: true,
  capability: null as string | null,
}));

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../../src/http/project-access", () => ({
  withProjectAccess: async (
    _context: unknown,
    capability: string,
    handler: (access: { projectId: string; actorUserId: string }) => Promise<Response>,
  ) => {
    mocks.capability = capability;
    if (!mocks.allowed) return new Response(null, { status: 404 });
    return handler({ projectId: "project-1", actorUserId: "viewer" });
  },
}));

const { createAgentActivityRoutes } = await import("../../src/routes/agent-activity");

const SNAPSHOT = { agents: [], events: [], latestSeq: 0, serverTime: "2026-11-09T12:00:00.000Z" };
const ON = { AGENT_LIVE_ACTIVITY_ENABLED: "true" } as Env;

function setup() {
  const snapshot = vi.fn(async () => SNAPSHOT);
  const diff = vi.fn(async (_projectId: string, seq: number) => (seq === 7 ? "+line" : null));
  const revokeByGrantRef = vi.fn(async () => ({ kind: "revoked" as const }));
  const app = createAgentActivityRoutes({
    activity: () => ({
      snapshot,
      diff,
      presence: async () => ({ agents: [], serverTime: SNAPSHOT.serverTime }),
      eventsAfter: async () => [],
    }),
    grants: () => ({ revokeByGrantRef }),
  });
  return { app, snapshot, diff, revokeByGrantRef };
}

beforeEach(() => {
  mocks.allowed = true;
  mocks.capability = null;
});

describe("agent activity routes", () => {
  test("answer 404 while the feature is off", async () => {
    const { app, snapshot } = setup();
    const response = await app.request("/", {}, { AGENT_LIVE_ACTIVITY_ENABLED: "yes" } as Env);
    expect(response.status).toBe(404);
    expect(snapshot).not.toHaveBeenCalled();
  });

  test("return the snapshot for a reader of the project, uncached", async () => {
    const { app, snapshot } = setup();
    const response = await app.request("/", {}, ON);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(SNAPSHOT);
    expect(mocks.capability).toBe("docs.read");
    expect(snapshot).toHaveBeenCalledWith("project-1", "viewer");
  });

  test("hide the project from someone without access", async () => {
    mocks.allowed = false;
    const { app, snapshot } = setup();
    expect((await app.request("/", {}, ON)).status).toBe(404);
    expect(snapshot).not.toHaveBeenCalled();
  });

  test("revoke only as the signed-in member", async () => {
    const { app, revokeByGrantRef } = setup();
    const response = await app.request("/agents/grant-1", { method: "DELETE" }, ON);
    expect(response.status).toBe(200);
    expect(revokeByGrantRef).toHaveBeenCalledWith("viewer", "grant-1");
  });

  test("answer 404 for an agent that the member does not own", async () => {
    const { app, revokeByGrantRef } = setup();
    revokeByGrantRef.mockResolvedValueOnce({ kind: "not_found" } as never);
    expect((await app.request("/agents/other", { method: "DELETE" }, ON)).status).toBe(404);
  });

  test("return one diff, and refuse a bad event number", async () => {
    const { app, diff } = setup();
    const found = await app.request("/7/diff", {}, ON);
    expect(await found.json()).toEqual({ diff: "+line" });
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/8/diff", {}, ON)).status).toBe(404);
    diff.mockClear();
    for (const bad of ["0", "-1", "1e3", "99999999999999999", "abc"]) {
      expect((await app.request(`/${bad}/diff`, {}, ON)).status).toBe(404);
    }
    expect(diff).not.toHaveBeenCalled();
  });

  test("hide a diff from someone without access", async () => {
    mocks.allowed = false;
    const { app, diff } = setup();
    expect((await app.request("/7/diff", {}, ON)).status).toBe(404);
    expect(diff).not.toHaveBeenCalled();
  });

  test("stream a snapshot first, with headers that stop buffering", async () => {
    const { app } = setup();
    const response = await app.request("/stream", {}, ON);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"type":"snapshot"');
    await reader.cancel();
  });

  test("refuse a stream past the limit for one user, and free it on close", async () => {
    const { app } = setup();
    const open = await Promise.all(Array.from({ length: 5 }, () => app.request("/stream", {}, ON)));
    const readers = open.map((response) => response.body!.getReader());
    await Promise.all(readers.map((reader) => reader.read()));
    expect((await app.request("/stream", {}, ON)).status).toBe(429);
    await readers[0]!.cancel();
    await vi.waitFor(async () => {
      const next = await app.request("/stream", {}, ON);
      expect(next.status).toBe(200);
      await next.body!.cancel();
    });
    await Promise.all(readers.slice(1).map((reader) => reader.cancel()));
  });
});
