import { describe, expect, test, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";

const mocks = vi.hoisted(() => ({
  createAuth: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

vi.mock("@doxahq/auth", () => ({
  createAuth: mocks.createAuth,
  getSessionUser: vi.fn(),
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
