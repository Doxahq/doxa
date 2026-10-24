import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

vi.mock("@doxahq/auth", () => ({
  createAuth: vi.fn(),
  getSessionUser: mocks.getSessionUser,
  getTrustedOrigins: (env: { WEB_ORIGIN?: string }) => [env.WEB_ORIGIN].filter(Boolean),
}));

vi.mock("../../src/services/local-dev-user", () => ({
  ensureLocalDevUser: vi.fn(),
}));

const worker = (await import("../../src/index")).default;

describe("GET /me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns the signed-in user", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "user@doxa.so" });

    const response = await worker.fetch(
      new Request("https://api.doxa.so/me"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: { id: "user-1", email: "user@doxa.so" },
    });
  });

  test("returns a null email when the session has none", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user-1" });

    const response = await worker.fetch(
      new Request("https://api.doxa.so/me"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: { id: "user-1", email: null },
    });
  });

  test("returns 401 without a session", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/me"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
  });

  test("returns the local development user without a session lookup", async () => {
    const response = await worker.fetch(
      new Request("http://localhost:8787/me", {
        headers: { "x-doxa-user-id": "local-dev-user" },
      }),
      createEnv({ LOCAL_DEV_USER_ID: "local-dev-user" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: { id: "local-dev-user", email: "local-dev@doxa.local" },
    });
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  test("no longer serves the removed admin routes", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "admin-1", email: "admin@doxa.so" });

    const response = await worker.fetch(
      new Request("https://api.doxa.so/admin/me"),
      createEnv({ ADMIN_EMAILS: "admin@doxa.so" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });
});

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    WEB_ORIGIN: "https://doxa.so",
    ADMIN_EMAILS: "",
    ...overrides,
  } as never;
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}
