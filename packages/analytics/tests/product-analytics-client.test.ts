import { describe, expect, it } from "vitest";
import { ProductAnalyticsClient, type AnalyticsRecord, type AnalyticsSink } from "../src";
import { createTestProductAnalytics } from "../src/testing";

const USER_ID = "user_7f3a";
const ACCOUNT_ID = "0d9e2c1a-5b8f-4c3e-9a71-2f6b8d4e1c90";

describe("ProductAnalyticsClient", () => {
  it("sends a valid event with its groups", async () => {
    const { analytics, sink } = createTestProductAnalytics();
    analytics.capture({
      name: "project_created",
      distinctId: USER_ID,
      properties: { source: "starter", via: "mcp" },
      groups: { account: ACCOUNT_ID },
    });
    await analytics.flush();
    expect(sink.records).toEqual([
      {
        kind: "event",
        event: "project_created",
        distinctId: USER_ID,
        properties: { source: "starter", via: "mcp" },
        groups: { account: ACCOUNT_ID },
      },
    ]);
  });

  it("drops an event whose distinct ID is an email", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics();
    analytics.capture({ name: "email_verified", distinctId: "person@example.com", properties: {} });
    await analytics.flush();
    expect(sink.records).toEqual([]);
    expect(drops).toEqual([{ reason: "invalid", record: "event", name: "email_verified", paths: ["distinctId"] }]);
  });

  it("drops an event with a bad group key", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics();
    analytics.capture({
      name: "team_created",
      distinctId: USER_ID,
      properties: {},
      groups: { account: "Acme Corp" },
    });
    await analytics.flush();
    expect(sink.records).toEqual([]);
    expect(drops[0]?.paths).toEqual(["groups.account"]);
  });

  it("drops events and person properties of a person who opted out", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics({ isOptedOut: async (id) => id === USER_ID });
    analytics.capture({ name: "user_signed_in", distinctId: USER_ID, properties: { method: "github" } });
    analytics.identify({ distinctId: USER_ID, properties: { email: "person@example.com" } });
    analytics.capture({ name: "user_signed_in", distinctId: "user_other", properties: { method: "email" } });
    await analytics.flush();
    expect(sink.eventNames()).toEqual(["user_signed_in"]);
    expect(sink.recordsOf("event")[0]?.distinctId).toBe("user_other");
    expect(sink.recordsOf("person")).toEqual([]);
    expect(drops.map((drop) => drop.reason)).toEqual(["opted_out", "opted_out"]);
  });

  it("drops the event when the opt-out check fails", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics({
      isOptedOut: async () => {
        throw new Error("database is down");
      },
    });
    analytics.capture({ name: "email_verified", distinctId: USER_ID, properties: {} });
    await analytics.flush();
    expect(sink.records).toEqual([]);
    expect(drops).toEqual([{ reason: "opt_out_check_failed", record: "event", name: "email_verified" }]);
  });

  it("treats an opt-out check that throws at once as a failed check", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics({
      isOptedOut: () => {
        throw new Error("no database scope");
      },
    });
    expect(() => analytics.capture({ name: "team_created", distinctId: USER_ID, properties: {} })).not.toThrow();
    await analytics.flush();
    expect(sink.records).toEqual([]);
    expect(drops.map((drop) => drop.reason)).toEqual(["opt_out_check_failed"]);
  });

  it("reports an opted-out person's error without their ID", async () => {
    const { analytics, sink } = createTestProductAnalytics({ isOptedOut: async () => true });
    const error = new Error("boom");
    analytics.captureException(error, {
      distinctId: USER_ID,
      sessionId: "019a8f2c-7d1e-7b3a-9c4f-2e8d1a6b5c30",
      properties: { route: "/projects/:projectId", status: 500 },
    });
    await analytics.flush();
    expect(sink.records).toEqual([
      { kind: "exception", error, distinctId: null, sessionId: null, properties: { route: "/projects/:projectId", status: 500 } },
    ]);
  });

  it("links a known person's error to their browser session", async () => {
    const { analytics, sink } = createTestProductAnalytics();
    analytics.captureException(new Error("boom"), { distinctId: USER_ID, sessionId: "019a8f2c-7d1e-7b3a-9c4f-2e8d1a6b5c30" });
    await analytics.flush();
    expect(sink.recordsOf("exception")[0]).toMatchObject({ distinctId: USER_ID, sessionId: "019a8f2c-7d1e-7b3a-9c4f-2e8d1a6b5c30" });
  });

  it("keeps an error report whose context is bad, without the context", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics();
    analytics.captureException(new Error("boom"), { properties: { route: "https://doxa.so/invite/secret" } });
    await analytics.flush();
    expect(sink.recordsOf("exception")[0]?.properties).toEqual({});
    expect(drops[0]).toMatchObject({ reason: "invalid", record: "exception" });
  });

  it("splits person properties into set and set-once", async () => {
    const { analytics, sink } = createTestProductAnalytics();
    analytics.identify({
      distinctId: USER_ID,
      properties: { email: "person@example.com" },
      firstProperties: { signup_method: "google", created_at: "2026-11-25T10:00:00.000Z" },
    });
    await analytics.flush();
    expect(sink.recordsOf("person")).toEqual([
      {
        kind: "person",
        distinctId: USER_ID,
        properties: { email: "person@example.com" },
        firstProperties: { signup_method: "google", created_at: "2026-11-25T10:00:00.000Z" },
      },
    ]);
  });

  it("describes a group with catalog properties only", async () => {
    const { analytics, sink } = createTestProductAnalytics();
    analytics.describeGroup({ type: "account", key: ACCOUNT_ID, properties: { plan: "pro", interval: "year", founder: true } });
    await analytics.flush();
    expect(sink.recordsOf("group")).toEqual([
      { kind: "group", groupType: "account", groupKey: ACCOUNT_ID, properties: { plan: "pro", interval: "year", founder: true } },
    ]);
  });

  it("waits for opt-out checks before it flushes the sink", async () => {
    let release: (optedOut: boolean) => void = () => {};
    const check = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const { analytics, sink } = createTestProductAnalytics({ isOptedOut: () => check });
    analytics.capture({ name: "team_created", distinctId: USER_ID, properties: {} });
    const flushed = analytics.flush();
    expect(sink.flushCount).toBe(0);
    release(false);
    await flushed;
    expect(sink.eventNames()).toEqual(["team_created"]);
    expect(sink.flushCount).toBe(1);
  });

  it("captures events once their read ends, and flush waits for the read", async () => {
    let release: () => void = () => {};
    const read = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { analytics, sink } = createTestProductAnalytics();
    analytics.captureWhenReady(async () => {
      await read;
      return [{ name: "docs_published", distinctId: USER_ID, properties: { first_publish: true, via: "mcp" } }];
    });
    const flushed = analytics.flush();
    expect(sink.records).toEqual([]);
    release();
    await flushed;
    expect(sink.eventNames()).toEqual(["docs_published"]);
  });

  it("drops the events of a failed read", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics();
    analytics.captureWhenReady(async () => {
      throw new Error("database closed");
    });
    analytics.captureWhenReady(() => {
      throw new Error("thrown before a promise");
    });
    await analytics.flush();
    expect(sink.records).toEqual([]);
    expect(drops.map((drop) => drop.reason)).toEqual(["read_failed", "read_failed"]);
  });

  it("never throws when the sink throws", async () => {
    const records: AnalyticsRecord[] = [];
    const brokenSink: AnalyticsSink = {
      provider: "broken",
      send: (record) => {
        records.push(record);
        throw new Error("provider down");
      },
      flush: async () => {
        throw new Error("provider down");
      },
      shutdown: async () => {},
    };
    const drops: string[] = [];
    const analytics = new ProductAnalyticsClient({ sink: brokenSink, onDrop: (drop) => drops.push(drop.reason) });
    expect(() => analytics.capture({ name: "team_created", distinctId: USER_ID, properties: {} })).not.toThrow();
    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(records).toHaveLength(1);
    expect(drops).toEqual(["sink_failed", "sink_failed"]);
  });
});
