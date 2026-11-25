import { createTestProductAnalytics } from "@doxahq/analytics/testing";
import {
  authEventHooks,
  createAuth,
  signInMethodOf,
  type AuthEvents,
  type AuthHookContext,
} from "@doxahq/auth";
import { describe, expect, test, vi } from "vitest";
import { authAnalyticsEvents } from "../../src/services/analytics/auth-analytics-events";

const env = {
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  BETTER_AUTH_SECRET: "auth-events-secret-for-tests-only",
  BETTER_AUTH_URL: "https://api.doxa.so",
  WEB_ORIGIN: "https://doxa.so",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

const CREATED_AT = new Date("2026-11-25T12:00:00.000Z");
const USER = { id: "user-1", email: "ada@example.com", createdAt: CREATED_AT };

/** An endpoint context as a hook gets it, with background tasks kept for the test to await. */
function hookContext(endpoint: Pick<AuthHookContext, "path" | "params" | "body">) {
  const background: Promise<unknown>[] = [];
  const findUserById = vi.fn(async (userId: string) => (userId === USER.id ? { email: USER.email } : null));
  const context: AuthHookContext = {
    ...endpoint,
    context: { runInBackground: (task) => void background.push(task), internalAdapter: { findUserById } },
  };
  return { context, findUserById, settled: () => Promise.all(background) };
}

function recordingEvents() {
  const calls: Array<[keyof AuthEvents, unknown]> = [];
  const events: AuthEvents = {
    userCreated: (event) => void calls.push(["userCreated", event]),
    sessionCreated: (event) => void calls.push(["sessionCreated", event]),
    emailVerified: (event) => void calls.push(["emailVerified", event]),
  };
  return { events, calls };
}

describe("signInMethodOf", () => {
  test.each([
    [{ path: "/callback/:id", params: { id: "github" } }, "github"],
    [{ path: "/callback/google" }, "google"],
    [{ path: "/sign-in/social", body: { provider: "google", idToken: { token: "t" } } }, "google"],
    [{ path: "/sign-up/email" }, "email"],
    [{ path: "/sign-in/email" }, "email"],
    [{ path: "/verify-email" }, "email"],
  ] as const)("%o is %s", (endpoint, method) => {
    expect(signInMethodOf(hookContext(endpoint).context)).toBe(method);
  });

  test.each([
    [{ path: "/callback/:id", params: { id: "apple" } }],
    [{ path: "/sign-in/social", body: { provider: "github; drop" } }],
    [{ path: "/sign-in/social" }],
    [{ path: "/change-password" }],
    [{}],
  ])("does not guess for %o", (endpoint) => {
    expect(signInMethodOf(hookContext(endpoint).context)).toBeNull();
  });

  test("does not guess without a context", () => {
    expect(signInMethodOf(null)).toBeNull();
  });
});

describe("authEventHooks", () => {
  test("reports a new user with the method of the endpoint", async () => {
    const { events, calls } = recordingEvents();
    await authEventHooks(events).userCreated(USER, hookContext({ path: "/sign-up/email" }).context);

    expect(calls).toEqual([["userCreated", { userId: "user-1", email: USER.email, method: "email", createdAt: CREATED_AT }]]);
  });

  test("reports a new session in a background task, with the user's email", async () => {
    const { events, calls } = recordingEvents();
    const hook = hookContext({ path: "/callback/:id", params: { id: "github" } });

    await authEventHooks(events).sessionCreated({ userId: "user-1" }, hook.context);
    await hook.settled();

    expect(hook.findUserById).toHaveBeenCalledWith("user-1");
    expect(calls).toEqual([["sessionCreated", { userId: "user-1", email: USER.email, method: "github" }]]);
  });

  test("sends nothing when the method or the user is unknown", async () => {
    const { events, calls } = recordingEvents();
    const hooks = authEventHooks(events);
    const unknownPath = hookContext({ path: "/change-password" });
    const unknownUser = hookContext({ path: "/sign-in/email" });

    await hooks.userCreated(USER, null);
    await hooks.sessionCreated({ userId: "user-1" }, unknownPath.context);
    await hooks.sessionCreated({ userId: "user-9" }, unknownUser.context);
    await Promise.all([unknownPath.settled(), unknownUser.settled()]);

    expect(unknownPath.findUserById).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test("never fails auth, even when the reporter or the lookup throws", async () => {
    const throwing: AuthEvents = {
      userCreated: () => {
        throw new Error("reporter down");
      },
      sessionCreated: () => {
        throw new Error("reporter down");
      },
      emailVerified: () => {
        throw new Error("reporter down");
      },
    };
    const hooks = authEventHooks(throwing);
    const session = hookContext({ path: "/sign-in/email" });
    const failedLookup = hookContext({ path: "/sign-in/email" });
    failedLookup.findUserById.mockRejectedValue(new Error("database down"));

    await expect(hooks.userCreated(USER, session.context)).resolves.toBeUndefined();
    await expect(hooks.sessionCreated({ userId: "user-1" }, session.context)).resolves.toBeUndefined();
    await expect(hooks.sessionCreated({ userId: "user-1" }, failedLookup.context)).resolves.toBeUndefined();
    await expect(hooks.emailVerified(USER)).resolves.toBeUndefined();
    await expect(Promise.all([session.settled(), failedLookup.settled()])).resolves.toBeDefined();
  });
});

describe("createAuth events", () => {
  test("wires the hooks only when the API passes events", async () => {
    const { events } = recordingEvents();
    const withEvents = (await createAuth(env, undefined, undefined, { events }).$context).options;
    const without = (await createAuth(env).$context).options;

    expect(withEvents.databaseHooks?.user?.create?.after).toBeTypeOf("function");
    expect(withEvents.databaseHooks?.session?.create?.after).toBeTypeOf("function");
    expect(withEvents.emailVerification?.afterEmailVerification).toBeTypeOf("function");
    // Closed sign-ups still refuse every new user.
    expect(withEvents.databaseHooks?.user?.create?.before).toBeTypeOf("function");
    expect(without.databaseHooks?.user?.create?.after).toBeUndefined();
    expect(without.databaseHooks?.session).toBeUndefined();
    expect(without.emailVerification?.afterEmailVerification).toBeUndefined();
  });
});

describe("authAnalyticsEvents", () => {
  test("a sign-up sends user_signed_up and sets the person once", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics();
    authAnalyticsEvents(analytics).userCreated({ userId: "user-1", email: USER.email, method: "github", createdAt: CREATED_AT });
    await analytics.flush();

    expect(drops).toEqual([]);
    expect(sink.recordsOf("event")).toMatchObject([
      { event: "user_signed_up", distinctId: "user-1", properties: { method: "github" } },
    ]);
    expect(sink.recordsOf("person")).toEqual([
      {
        kind: "person",
        distinctId: "user-1",
        properties: { email: USER.email },
        firstProperties: { signup_method: "github", created_at: "2026-11-25T12:00:00.000Z" },
      },
    ]);
  });

  test("a sign-in sends user_signed_in and keeps the email current", async () => {
    const { analytics, sink, drops } = createTestProductAnalytics();
    authAnalyticsEvents(analytics).sessionCreated({ userId: "user-1", email: "new@example.com", method: "email" });
    await analytics.flush();

    expect(drops).toEqual([]);
    expect(sink.eventNames()).toEqual(["user_signed_in"]);
    expect(sink.recordsOf("person")).toMatchObject([{ properties: { email: "new@example.com" }, firstProperties: {} }]);
  });

  test("a verification sends email_verified", async () => {
    const { analytics, sink } = createTestProductAnalytics();
    authAnalyticsEvents(analytics).emailVerified({ userId: "user-1" });
    await analytics.flush();

    expect(sink.recordsOf("event")).toMatchObject([{ event: "email_verified", distinctId: "user-1" }]);
  });

  test("an opted-out person sends nothing", async () => {
    const { analytics, sink } = createTestProductAnalytics({ isOptedOut: async () => true });
    authAnalyticsEvents(analytics).sessionCreated({ userId: "user-1", email: USER.email, method: "google" });
    await analytics.flush();

    expect(sink.records).toEqual([]);
  });
});
