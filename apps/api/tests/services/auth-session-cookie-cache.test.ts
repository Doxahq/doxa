import { createHmac } from "node:crypto";
import {
  getSessionUser,
  sessionCacheCookies,
  type AuthEnv,
} from "@doxahq/auth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The real Better Auth instance of the API, with the session store (KV)
 * replaced by a map. Cookie signing, the cookie cache, and its expiry are not
 * mocked.
 */
function sessionStore() {
  const values = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  return { kv, values };
}

const secret = "production-secret-for-cookie-tests-only";

function prodEnv(kv: unknown): AuthEnv {
  return {
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    AUTH_KV: kv as AuthEnv["AUTH_KV"],
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: "https://api.doxa.so",
    WEB_ORIGIN: "https://doxa.so",
    AUTH_COOKIE_DOMAIN: ".doxa.so",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
  };
}

function storeSession(values: Map<string, string>, userId: string) {
  const createdAt = new Date();
  const token = `token-${userId}`;
  values.set(
    token,
    JSON.stringify({
      session: {
        id: `session-${userId}`,
        token,
        userId,
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ipAddress: null,
        userAgent: null,
      },
      user: {
        id: userId,
        name: userId,
        email: `${userId}@example.com`,
        emailVerified: true,
        image: null,
        createdAt,
        updatedAt: createdAt,
      },
    }),
  );
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

function apiRequest(...cookies: string[]) {
  return new Request("https://api.doxa.so/projects", {
    headers: { cookie: cookies.join("; "), origin: "https://doxa.so" },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the API keeps the session cookie cache fresh", () => {
  test("a lookup from the session store issues a new cookie cache value", async () => {
    const { kv, values } = sessionStore();
    const tokenCookie = storeSession(values, "user-1");
    const issued: string[] = [];

    const user = await getSessionUser(prodEnv(kv), apiRequest(tokenCookie), {
      onSessionCookies: (cookies) => issued.push(...cookies),
    });

    expect(user?.id).toBe("user-1");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatch(/^__Secure-better-auth\.session_data=[^;]+;/);
    expect(issued[0]).toMatch(/Domain=\.?doxa\.so/i);
    expect(issued[0]).toMatch(/HttpOnly/i);
    expect(issued[0]).toMatch(/Secure/i);
    // A read never writes the session store.
    expect(kv.put).not.toHaveBeenCalled();
  });

  test("a fresh cookie cache answers without the session store and sets nothing", async () => {
    const { kv, values } = sessionStore();
    const tokenCookie = storeSession(values, "user-1");
    const issued: string[] = [];
    await getSessionUser(prodEnv(kv), apiRequest(tokenCookie), {
      onSessionCookies: (cookies) => issued.push(...cookies),
    });
    const cacheCookie = issued[0]!.split(";")[0]!;
    kv.get.mockClear();
    const later: string[] = [];

    const user = await getSessionUser(
      prodEnv(kv),
      apiRequest(tokenCookie, cacheCookie),
      { onSessionCookies: (cookies) => later.push(...cookies) },
    );

    expect(user?.id).toBe("user-1");
    expect(kv.get).not.toHaveBeenCalled();
    expect(later).toEqual([]);
  });

  test("an expired cookie cache is issued again", async () => {
    const { kv, values } = sessionStore();
    const tokenCookie = storeSession(values, "user-1");
    const issued: string[] = [];
    await getSessionUser(prodEnv(kv), apiRequest(tokenCookie), {
      onSessionCookies: (cookies) => issued.push(...cookies),
    });
    const cacheCookie = issued[0]!.split(";")[0]!;
    vi.setSystemTime(new Date("2026-10-22T12:06:00Z"));
    const later: string[] = [];

    const user = await getSessionUser(
      prodEnv(kv),
      apiRequest(tokenCookie, cacheCookie),
      { onSessionCookies: (cookies) => later.push(...cookies) },
    );

    expect(user?.id).toBe("user-1");
    expect(later).toHaveLength(1);
    expect(later[0]!.split(";")[0]).not.toBe(cacheCookie);
  });

  test("an unknown session forwards no cookie, not even one that clears it", async () => {
    const { kv, values } = sessionStore();
    const tokenCookie = storeSession(values, "user-1");
    values.clear();
    const onSessionCookies = vi.fn();

    const user = await getSessionUser(prodEnv(kv), apiRequest(tokenCookie), {
      onSessionCookies,
    });

    expect(user).toBeNull();
    expect(onSessionCookies).not.toHaveBeenCalled();
  });

  test("without the option, the lookup stays read-only for cookies too", async () => {
    const { kv, values } = sessionStore();
    const tokenCookie = storeSession(values, "user-1");

    const user = await getSessionUser(prodEnv(kv), apiRequest(tokenCookie));

    expect(user?.id).toBe("user-1");
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("session cache cookies", () => {
  test("keeps only cookie cache values that set a cookie", () => {
    const headers = new Headers();
    headers.append("set-cookie", "__Secure-better-auth.session_data=abc; Path=/; HttpOnly; Secure");
    headers.append("set-cookie", "doxa-dev.session_data.0=part; Path=/");
    headers.append("set-cookie", "__Secure-better-auth.session_data=; Max-Age=0; Path=/");
    headers.append("set-cookie", "__Secure-better-auth.session_token=; Max-Age=0; Path=/");
    headers.append("set-cookie", "__Secure-better-auth.session_token=token.sig; Path=/");
    headers.append("set-cookie", "other.my_session_data_x=1; Path=/");

    expect(sessionCacheCookies(headers)).toEqual([
      "__Secure-better-auth.session_data=abc; Path=/; HttpOnly; Secure",
      "doxa-dev.session_data.0=part; Path=/",
    ]);
    expect(sessionCacheCookies(null)).toEqual([]);
  });
});
