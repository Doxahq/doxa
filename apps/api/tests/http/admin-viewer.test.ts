import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSessionUser: vi.fn() }));

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("@doxahq/auth", () => ({ getSessionUser: mocks.getSessionUser }));

import { createApiRouter } from "../../src/http/app";
import { requestSessionUser } from "../../src/http/auth";
import { requestState } from "../../src/http/request-state";
import { json } from "../../src/http/response";

const env = { ADMIN_EMAILS: "admin@doxa.so" };

function app() {
  const router = createApiRouter();
  router.get("/viewer", async (context) => {
    await requestSessionUser(context);
    const state = requestState(context.req.raw, context.env);
    return json({ admin: state.timing.allowed, setCookies: state.setCookies });
  });
  return router;
}

async function isAdminFor(user: unknown): Promise<boolean> {
  mocks.getSessionUser.mockResolvedValue(user);
  const response = await app().request("https://api.doxa.so/viewer", {}, env as never);
  return ((await response.json()) as { admin: boolean }).admin;
}

/** SECURITY REGRESSION GUARDRAIL (SEC-018): admin needs a verified email. */
describe("admin viewer", () => {
  beforeEach(() => mocks.getSessionUser.mockReset());

  test("is an admin with a verified listed email", async () => {
    await expect(isAdminFor({ id: "u1", email: "Admin@Doxa.so", emailVerified: true })).resolves.toBe(true);
  });

  test("is not an admin with an unverified listed email", async () => {
    await expect(isAdminFor({ id: "u1", email: "admin@doxa.so", emailVerified: false })).resolves.toBe(false);
  });

  test("is not an admin with a verified email that is not listed", async () => {
    await expect(isAdminFor({ id: "u1", email: "user@doxa.so", emailVerified: true })).resolves.toBe(false);
  });
});

/** SECURITY REGRESSION GUARDRAIL (SEC-021): API requests keep the dashboard marker in step. */
describe("signed-in marker sync", () => {
  beforeEach(() => mocks.getSessionUser.mockReset());

  async function setCookiesFor(user: unknown, cookie: string): Promise<string[]> {
    mocks.getSessionUser.mockResolvedValue(user);
    const response = await app().request(
      "https://api.doxa.so/viewer",
      { headers: { cookie } },
      { ...env, WEB_ORIGIN: "https://doxa.so" } as never,
    );
    return ((await response.json()) as { setCookies: string[] }).setCookies;
  }

  test("sets the marker for a session without one", async () => {
    const cookies = await setCookiesFor({ id: "u1", emailVerified: true }, "x=1");
    expect(cookies.some((cookie) => cookie.startsWith("doxa.signed_in=1;"))).toBe(true);
  });

  test("clears a marker that has no session", async () => {
    const cookies = await setCookiesFor(null, "doxa.signed_in=1");
    expect(cookies.some((cookie) => cookie.startsWith("doxa.signed_in=;") && cookie.includes("Max-Age=0"))).toBe(true);
  });

  test("changes nothing when the marker matches the session", async () => {
    await expect(setCookiesFor({ id: "u1", emailVerified: true }, "doxa.signed_in=1")).resolves.toEqual([]);
    await expect(setCookiesFor(null, "x=1")).resolves.toEqual([]);
  });
});
