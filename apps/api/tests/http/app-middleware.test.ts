import { describe, expect, test, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { createTestProductAnalytics } from "@doxahq/analytics/testing";

const mocks = vi.hoisted(() => ({
  createAuth: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

vi.mock("@doxahq/auth", () => ({
  createAuth: mocks.createAuth,
  getSessionUser: mocks.getSessionUser,
  getTrustedOrigins: (env: { WEB_ORIGIN?: string }) => [env.WEB_ORIGIN].filter(Boolean),
}));

const worker = (await import("../../src/index")).default;

describe("app middleware", () => {
  test("sets security headers on route responses", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/health"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("answers the readiness route with 503 and names the failed check", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/health/ready"),
      createEnv({ AUTH_KV: { get: vi.fn(async () => null) } }),
      createExecutionContext(),
    );

    // No database in this test env, so the database check fails: the route
    // must then answer 503 and name only the check.
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { ok: boolean; checks: Record<string, string> };
    expect(body.ok).toBe(false);
    expect(body.checks.cache).toBe("ok");
    expect(["failed", "timeout"]).toContain(body.checks.database);
  });

  test("handles credentialed CORS preflights for the configured web origin", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects", {
        method: "OPTIONS",
        headers: { origin: "https://doxa.so" },
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://doxa.so");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-doxa-user-id");
    // posthog-js `tracing_headers` adds these to every dashboard call.
    expect(response.headers.get("access-control-allow-headers")).toContain("x-posthog-distinct-id");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-posthog-session-id");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-posthog-window-id");
  });

  test("does not allow credentialed CORS for untrusted origins", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/health", {
        headers: { origin: "https://evil.example" },
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("logs wrapped database errors without query parameters", async () => {
    const postgresError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint: "generation_jobs_active_concurrency_idx",
    });
    const queryError = new DrizzleQueryError(
      "insert into generation_jobs values ($1)",
      ["sensitive-value"],
      postgresError,
    );
    mocks.createAuth.mockReturnValueOnce({
      handler: async () => {
        throw queryError;
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/api/auth/callback"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      "Unhandled request error.",
      expect.objectContaining({
        name: "Error",
        message: "Database query failed.",
        code: "23505",
        constraint: "generation_jobs_active_concurrency_idx",
      }),
    );
    const logged = consoleError.mock.calls[0]?.[1] as { stack?: string };
    expect(logged.stack).toMatch(/^\s+at\s/);
    expect(logged.stack).not.toContain("insert into generation_jobs");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sensitive-value");
    consoleError.mockRestore();
  });

  test("redacts a query error that only appears on the cause chain", async () => {
    const queryError = new DrizzleQueryError(
      "select * from projects where id = $1",
      ["sensitive-value"],
      new Error("driver failure"),
    );
    const wrapper = new Error(
      "Failed query: select * from projects where id = $1",
      { cause: queryError },
    );
    mocks.createAuth.mockReturnValueOnce({
      handler: async () => {
        throw wrapper;
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/api/auth/callback"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      "Unhandled request error.",
      expect.objectContaining({ message: "Database query failed." }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sensitive-value");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("select * from projects");
    consoleError.mockRestore();
  });
});

describe("API error reports", () => {
  test("reports an unexpected 500 with the route pattern and without query text", async () => {
    const { analytics, sink } = createTestProductAnalytics();
    mocks.createAuth.mockReturnValueOnce({
      handler: async () => {
        throw new Error("Failed query: select * from projects", {
          cause: new DrizzleQueryError("select * from projects where id = $1", ["sensitive-value"], new Error("driver")),
        });
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/api/auth/callback/github?code=secret-code", {
        headers: { "x-posthog-session-id": "session-1" },
      }),
      createEnv({ PRODUCT_ANALYTICS: { forEnv: () => analytics } }),
      createExecutionContext(),
    );
    await analytics.flush();

    expect(response.status).toBe(500);
    const [report] = sink.recordsOf("exception");
    expect(report).toMatchObject({
      distinctId: null,
      // No user, so no session: the replay link needs a person.
      sessionId: null,
      properties: { route: "/api/auth/*", method: "GET", status: 500 },
    });
    expect(JSON.stringify(report)).not.toContain("secret-code");
    expect(report?.error).toBeInstanceOf(Error);
    expect(report?.error).toMatchObject({
      message: "Error",
      stack: expect.not.stringContaining("select * from projects"),
    });
    consoleError.mockRestore();
  });

  test("reports the error name and stack frames, never the message", async () => {
    const { analytics, sink } = createTestProductAnalytics();
    mocks.createAuth.mockReturnValueOnce({
      handler: async () => {
        throw new TypeError("Repository acme/secret-plans has no file docs/billing.mdx");
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await worker.fetch(
      new Request("https://api.doxa.so/api/auth/callback"),
      createEnv({ PRODUCT_ANALYTICS: { forEnv: () => analytics } }),
      createExecutionContext(),
    );
    await analytics.flush();

    const [report] = sink.recordsOf("exception");
    expect(report?.error).toMatchObject({ name: "TypeError", message: "TypeError" });
    expect(JSON.stringify(report)).not.toContain("secret-plans");
    expect(String(report?.error instanceof Error ? report.error.stack : "")).not.toContain("secret-plans");
    consoleError.mockRestore();
  });

  test("names the session user that the request already read, and its browser session", async () => {
    const { analytics, sink } = createTestProductAnalytics();
    mocks.getSessionUser.mockResolvedValueOnce({ id: "user-1", emailVerified: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // No database in this env, so the route fails after the session lookup.
    const response = await worker.fetch(
      new Request("https://api.doxa.so/privacy-settings", { headers: { "x-posthog-session-id": "session-1" } }),
      createEnv({ PRODUCT_ANALYTICS: { forEnv: () => analytics } }),
      createExecutionContext(),
    );
    await analytics.flush();

    expect(response.status).toBe(500);
    expect(mocks.getSessionUser).toHaveBeenCalledTimes(1);
    expect(sink.recordsOf("exception")).toMatchObject([
      { distinctId: "user-1", sessionId: "session-1", properties: { route: "/privacy-settings", method: "GET", status: 500 } },
    ]);
    consoleError.mockRestore();
  });

  test("reports nothing for an answer that is not a 5xx", async () => {
    const { analytics, sink } = createTestProductAnalytics();

    const response = await worker.fetch(
      new Request("https://api.doxa.so/no-such-route"),
      createEnv({ PRODUCT_ANALYTICS: { forEnv: () => analytics } }),
      createExecutionContext(),
    );
    await analytics.flush();

    expect(response.status).toBe(404);
    expect(sink.records).toEqual([]);
  });
});

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    WEB_ORIGIN: "https://doxa.so",
    GENERATION_QUEUE: { send: vi.fn() },
    DOCS_BUCKET: {},
    ...overrides,
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}
