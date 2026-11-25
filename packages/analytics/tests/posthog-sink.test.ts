import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => {
  const constructed: { options?: unknown } = {};
  return {
    constructed,
    capture: vi.fn(),
    setPersonProperties: vi.fn(),
    groupIdentify: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    on: vi.fn(),
  };
});

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(_key: string, options: unknown) {
      client.constructed.options = options;
    }
    capture = client.capture;
    setPersonProperties = client.setPersonProperties;
    groupIdentify = client.groupIdentify;
    captureException = client.captureException;
    flush = client.flush;
    shutdown = client.shutdown;
    on = client.on;
  },
}));

const { PostHogSink } = await import("../src/providers/posthog");

const SETTINGS = { projectKey: "phc_test", host: "https://relay.doxa.so" };

describe("PostHogSink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends immediately in a Worker and turns GeoIP off", () => {
    new PostHogSink({ settings: SETTINGS, delivery: "immediate" });
    expect(client.constructed.options).toEqual({
      host: "https://relay.doxa.so",
      flushAt: 1,
      flushInterval: 0,
      disableGeoip: true,
      enableExceptionAutocapture: false,
    });
  });

  it("maps each record kind to its SDK call", () => {
    const sink = new PostHogSink({ settings: SETTINGS, delivery: "batched" });
    const error = new Error("boom");
    sink.send({
      kind: "event",
      event: "team_created",
      distinctId: "user_1",
      properties: {},
      groups: { account: "acc_1", project: undefined },
    });
    sink.send({ kind: "person", distinctId: "user_1", properties: { email: "a@b.co" }, firstProperties: { signup_method: "email" } });
    sink.send({ kind: "group", groupType: "project", groupKey: "prj_1", properties: { source: "repo" } });
    sink.send({ kind: "exception", error, distinctId: null, sessionId: null, properties: { status: 500 } });
    sink.send({ kind: "exception", error, distinctId: "user_1", sessionId: "sess_1", properties: {} });

    expect(client.capture).toHaveBeenCalledWith({
      distinctId: "user_1",
      event: "team_created",
      properties: {},
      groups: { account: "acc_1" },
    });
    expect(client.setPersonProperties).toHaveBeenCalledWith({
      distinctId: "user_1",
      properties: { email: "a@b.co" },
      propertiesOnce: { signup_method: "email" },
    });
    expect(client.groupIdentify).toHaveBeenCalledWith({ groupType: "project", groupKey: "prj_1", properties: { source: "repo" } });
    expect(client.captureException).toHaveBeenCalledWith(error, { properties: { status: 500 } });
    expect(client.captureException).toHaveBeenCalledWith(error, { distinctId: "user_1", properties: { $session_id: "sess_1" } });
  });
});
