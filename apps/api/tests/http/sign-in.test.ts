import { describe, expect, test } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { createSignInRoutes, type AuthRequestHandler } from "../../src/routes/sign-in";

const PROVIDER_URL = "https://github.com/login/oauth/authorize?state=abc";
const STATE_COOKIE = "better-auth.state=abc; Path=/; HttpOnly; Secure; SameSite=Lax";

interface Setup {
  handler?: AuthRequestHandler;
  env?: Record<string, string>;
}

function setup({ handler, env = {} }: Setup = {}) {
  const forwarded: Request[] = [];
  const authHandler: AuthRequestHandler = async (context, request) => {
    forwarded.push(request);
    if (handler) return handler(context, request);
    const headers = new Headers({ "content-type": "application/json", location: PROVIDER_URL });
    headers.append("set-cookie", STATE_COOKIE);
    headers.append("set-cookie", "better-auth.pkce=xyz; Path=/; HttpOnly");
    return new Response(JSON.stringify({ url: PROVIDER_URL, redirect: true }), { headers });
  };

  const app = createApiRouter();
  app.route("/sign-in", createSignInRoutes(authHandler));
  const send = (path: string, headers: Record<string, string> = {}) =>
    app.request(`https://api.doxa.so${path}`, { headers }, {
      BETTER_AUTH_URL: "https://api.doxa.so",
      WEB_ORIGIN: "https://doxa.so",
      ...env,
    });
  return { send, forwarded };
}

describe("GET /sign-in/:provider", () => {
  test("redirects to the provider and keeps the state cookies", async () => {
    const { send } = setup();

    const response = await send("/sign-in/github?redirect=%2Fdashboard%2Fprojects");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(PROVIDER_URL);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([
      STATE_COOKIE,
      "better-auth.pkce=xyz; Path=/; HttpOnly",
    ]);
  });

  test("sends the Better Auth sign-in request with a callback on the web origin", async () => {
    const { send, forwarded } = setup();

    await send("/sign-in/google?redirect=%2Finvite%2Ftok%3Fa%3D1", { cookie: "a=b" });

    const [request] = forwarded;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/api/auth/sign-in/social");
    expect(request.headers.get("origin")).toBe("https://doxa.so");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("cookie")).toBe("a=b");
    expect(await request.json()).toEqual({
      provider: "google",
      callbackURL: "https://doxa.so/invite/tok?a=1",
      errorCallbackURL: "https://doxa.so/login?redirect=%2Finvite%2Ftok%3Fa%3D1",
    });
  });

  test("uses a trusted Referer as the web origin", async () => {
    const { send, forwarded } = setup({ env: { BETTER_AUTH_TRUSTED_ORIGINS: "https://*.doxa.so" } });

    await send("/sign-in/github", { referer: "https://dev.doxa.so/login?redirect=x" });

    expect(await forwarded[0].json()).toMatchObject({ callbackURL: "https://dev.doxa.so/dashboard" });
    expect(forwarded[0].headers.get("origin")).toBe("https://dev.doxa.so");
  });

  test("ignores an untrusted Referer", async () => {
    const { send, forwarded } = setup();

    await send("/sign-in/github", { referer: "https://evil.example/login" });

    expect(await forwarded[0].json()).toMatchObject({ callbackURL: "https://doxa.so/dashboard" });
  });

  test.each([
    "https://evil.example/x",
    "//evil.example/x",
    "/\\evil.example",
    "dashboard",
    "/a\r",
  ])("replaces the unsafe redirect %s with /dashboard", async (redirect) => {
    const { send, forwarded } = setup();

    await send(`/sign-in/github?redirect=${encodeURIComponent(redirect)}`);

    expect(await forwarded[0].json()).toMatchObject({ callbackURL: "https://doxa.so/dashboard" });
  });

  test("rejects an unknown provider", async () => {
    const { send, forwarded } = setup();

    const response = await send("/sign-in/twitter");

    expect(response.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  test("blocks a cross-site start", async () => {
    const { send, forwarded } = setup();

    const response = await send("/sign-in/github", { "sec-fetch-site": "cross-site" });

    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  test.each([
    ["an error status", async () => new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 })],
    ["a response without a URL", async () => new Response(JSON.stringify({ redirect: false }))],
    ["a thrown error", async () => { throw new Error("database down"); }],
  ])("sends the person back to the login page after %s", async (_name, handler) => {
    const { send } = setup({ handler });

    const response = await send("/sign-in/github?redirect=%2Fdashboard%2Fsettings");

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://doxa.so");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("sign-in-unavailable");
    expect(location.searchParams.get("redirect")).toBe("/dashboard/settings");
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
