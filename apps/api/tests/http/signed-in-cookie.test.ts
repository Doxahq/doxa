import { describe, expect, test } from "vitest";
import {
  hasSignedInCookie,
  signedInChangeFor,
  signedInCookie,
  withSignedInCookieSync,
} from "../../src/http/signed-in-cookie";

const env = { WEB_ORIGIN: "https://doxa.so", AUTH_COOKIE_PREFIX: undefined };

/** SECURITY REGRESSION GUARDRAIL (SEC-021): the marker follows the session and holds no secret. */
describe("signed-in marker", () => {
  test("is a non-secret marker for the dashboard domain", () => {
    expect(signedInCookie(env, true)).toBe(
      "doxa.signed_in=1; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Domain=doxa.so; Secure",
    );
    expect(signedInCookie(env, false)).toContain("doxa.signed_in=; Path=/; Max-Age=0");
  });

  test("is host-only for a local dashboard, and uses the dev cookie prefix", () => {
    const cookie = signedInCookie({ WEB_ORIGIN: "http://localhost:3001", AUTH_COOKIE_PREFIX: "doxa-dev" }, true);
    expect(cookie).toBe("doxa-dev.signed_in=1; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax");
  });

  test("is set when Better Auth sets a session token and cleared when it clears it", () => {
    const signIn = new Response(null, { status: 302 });
    signIn.headers.append("set-cookie", "__Secure-better-auth.session_token=abc.def; Path=/; HttpOnly; Secure");
    expect(signedInChangeFor(signIn)).toBe(true);

    const signOut = new Response(null);
    signOut.headers.append("set-cookie", "__Secure-better-auth.session_token=; Max-Age=0; Path=/");
    expect(signedInChangeFor(signOut)).toBe(false);

    expect(signedInChangeFor(new Response(null))).toBeNull();
  });

  test("is added to a sign-in response with its other cookies", async () => {
    const signIn = new Response(null, { status: 302, headers: { location: "https://doxa.so/dashboard" } });
    signIn.headers.append("set-cookie", "better-auth.session_token=abc; Path=/");

    const synced = await withSignedInCookieSync(new Request("https://api.doxa.so/api/auth/callback/github"), signIn, env);

    expect(synced.status).toBe(302);
    expect(synced.headers.getSetCookie()).toEqual([
      "better-auth.session_token=abc; Path=/",
      signedInCookie(env, true),
    ]);
  });

  test("is cleared when a session read finds no session", async () => {
    const request = new Request("https://api.doxa.so/api/auth/get-session", { headers: { cookie: "doxa.signed_in=1" } });
    const synced = await withSignedInCookieSync(request, Response.json(null), env);

    expect(synced.headers.getSetCookie()).toEqual([signedInCookie(env, false)]);
    await expect(synced.json()).resolves.toBeNull();
  });

  test("is kept when a session read finds a session", async () => {
    const request = new Request("https://api.doxa.so/api/auth/get-session", { headers: { cookie: "doxa.signed_in=1" } });
    const synced = await withSignedInCookieSync(request, Response.json({ user: { id: "u1" } }), env);

    expect(synced.headers.getSetCookie()).toEqual([]);
  });

  test("clears the old dashboard-domain session cookies on sign-out", async () => {
    const signOut = Response.json({ success: true });
    signOut.headers.append("set-cookie", "__Secure-better-auth.session_token=; Max-Age=0; Path=/; Secure");
    signOut.headers.append("set-cookie", "__Secure-better-auth.session_data=; Max-Age=0; Path=/; Secure");

    const synced = await withSignedInCookieSync(
      new Request("https://api.doxa.so/api/auth/sign-out", { method: "POST" }),
      signOut,
      { ...env, AUTH_COOKIE_DOMAIN: undefined },
    );

    expect(synced.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        signedInCookie(env, false),
        "__Secure-better-auth.session_token=; Path=/; Max-Age=0; Domain=doxa.so; HttpOnly; SameSite=Lax; Secure",
        "__Secure-better-auth.session_data=; Path=/; Max-Age=0; Domain=doxa.so; HttpOnly; SameSite=Lax; Secure",
      ]),
    );
  });

  test("is read only with the value 1", () => {
    const request = (cookie: string) => new Request("https://api.doxa.so/me", { headers: { cookie } });
    expect(hasSignedInCookie(request("a=b; doxa.signed_in=1"), env)).toBe(true);
    expect(hasSignedInCookie(request("doxa.signed_in="), env)).toBe(false);
    expect(hasSignedInCookie(request("other.signed_in=1"), env)).toBe(false);
  });
});
