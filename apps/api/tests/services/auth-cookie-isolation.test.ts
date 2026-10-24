import { createHmac } from "node:crypto";
import { createAuth, type AuthEnv } from "@doxahq/auth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const devEnv = {
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  BETTER_AUTH_SECRET: "development-secret-for-cookie-tests-only",
  BETTER_AUTH_URL: "https://dev.doxa.so",
  WEB_ORIGIN: "https://dev.doxa.so",
  AUTH_COOKIE_DOMAIN: "dev.doxa.so",
  AUTH_COOKIE_PREFIX: "doxa-dev",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

const prodEnv = {
  ...devEnv,
  BETTER_AUTH_SECRET: "production-secret-for-cookie-tests-only",
  BETTER_AUTH_URL: "https://api.doxa.so",
  WEB_ORIGIN: "https://doxa.so",
  AUTH_COOKIE_DOMAIN: ".doxa.so",
  AUTH_COOKIE_PREFIX: undefined,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function authenticatedFixture(env: AuthEnv, id: string, prefix: string) {
  const auth = createAuth(env);
  const context = await auth.$context;
  const createdAt = new Date();
  const stored = {
    session: {
      id: `session-${id}`, token: `token-${id}`, userId: id,
      createdAt, updatedAt: createdAt,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ipAddress: null, userAgent: null,
    },
    user: {
      id, name: id, email: `${id}@example.com`, emailVerified: true,
      image: null, createdAt, updatedAt: createdAt,
    },
  };
  // Only the database boundary is replaced. Cookie signing, parsing, and expiry
  // run through the real auth instance used by the API.
  vi.spyOn(context.internalAdapter, "findSession").mockImplementation(async (token) =>
    token === stored.session.token ? structuredClone(stored) : null,
  );
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(stored.session.token).digest("base64");
  const tokenCookie = `__Secure-${prefix}.session_token=${encodeURIComponent(`${stored.session.token}.${signature}`)}`;
  const response = await auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth/get-session`, {
    headers: { cookie: tokenCookie },
  }));
  const cacheCookies = response.headers.getSetCookie()
    .filter((cookie) => cookie.startsWith(`__Secure-${prefix}.session_data=`))
    .map((cookie) => cookie.split(";")[0]);
  return { auth, context, tokenCookie, cacheCookies };
}

describe("development authentication isolation", () => {
  test.each(["production-first", "development-first"])(
    "keeps the development session with mixed cookies: %s",
    async (order) => {
      const dev = await authenticatedFixture(devEnv, "dev-user", "doxa-dev");
      const prod = await authenticatedFixture(prodEnv, "prod-user", "better-auth");
      expect(dev.cacheCookies).toHaveLength(1);

      for (const cacheState of ["fresh", "expired", "removed"]) {
        if (cacheState !== "fresh") vi.setSystemTime(new Date("2026-09-24T12:06:00Z"));
        const localCookies = [dev.tokenCookie, ...(cacheState === "removed" ? [] : dev.cacheCookies)];
        const foreignCookies = [prod.tokenCookie, ...prod.cacheCookies];
        const cookies = order === "production-first"
          ? [...foreignCookies, ...localCookies]
          : [...localCookies, ...foreignCookies];
        const result = await dev.auth.api.getSession({
          headers: new Headers({ cookie: cookies.join("; ") }),
          query: { disableRefresh: true },
        });
        expect(result?.user.id, cacheState).toBe("dev-user");
        const productionResult = await prod.auth.api.getSession({
          headers: new Headers({ cookie: cookies.join("; ") }),
          query: { disableRefresh: true },
        });
        expect(productionResult?.user.id, cacheState).toBe("prod-user");
      }
    },
  );

  test("does not accept production cookies as a development login", async () => {
    const dev = createAuth(devEnv);
    const prod = await authenticatedFixture(prodEnv, "prod-user", "better-auth");
    const result = await dev.api.getSession({
      headers: new Headers({ cookie: [prod.tokenCookie, ...prod.cacheCookies].join("; ") }),
    });
    expect(result).toBeNull();
  });

  test("preserves production names, scope, and cookie lifetimes", async () => {
    const context = await createAuth(prodEnv).$context;
    expect(context.authCookies.sessionToken).toMatchObject({
      name: "__Secure-better-auth.session_token",
      attributes: { domain: ".doxa.so", maxAge: 604800, httpOnly: true, secure: true, sameSite: "lax" },
    });
    expect(context.authCookies.sessionData).toMatchObject({
      name: "__Secure-better-auth.session_data",
      attributes: { domain: ".doxa.so", maxAge: 300 },
    });
  });

  test("uses the development prefix for OAuth state and session cookies", async () => {
    const context = await createAuth(devEnv).$context;
    for (const cookie of [...Object.values(context.authCookies), context.createAuthCookie("state")]) {
      expect(cookie.name).toMatch(/^__Secure-doxa-dev\./);
      expect(cookie.attributes).toMatchObject({ domain: "dev.doxa.so", httpOnly: true, secure: true, sameSite: "lax" });
    }
  });

  test("applies the prefix without a shared domain or execution context", async () => {
    const context = await createAuth({
      ...devEnv,
      AUTH_COOKIE_DOMAIN: undefined,
      AUTH_COOKIE_PREFIX: " doxa-dev ",
    }).$context;
    expect(context.authCookies.sessionToken.name).toBe("__Secure-doxa-dev.session_token");
    expect(context.authCookies.sessionToken.attributes.domain).toBeUndefined();
  });

  test("treats an empty prefix as the existing production default", async () => {
    const context = await createAuth({ ...prodEnv, AUTH_COOKIE_PREFIX: "  " }).$context;
    expect(context.authCookies.sessionToken.name).toBe("__Secure-better-auth.session_token");
  });

  test("development sign-out expires only development cookies", async () => {
    const dev = await authenticatedFixture(devEnv, "dev-user", "doxa-dev");
    vi.spyOn(dev.context.internalAdapter, "deleteSession").mockResolvedValue(undefined);
    const response = await dev.auth.handler(new Request(`${devEnv.BETTER_AUTH_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: devEnv.WEB_ORIGIN, cookie: dev.tokenCookie, "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Secure-doxa-dev\./);
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("Domain=dev.doxa.so");
    }
  });
});
