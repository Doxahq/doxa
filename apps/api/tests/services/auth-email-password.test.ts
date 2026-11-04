import { createAuth, type AuthEmail, type AuthMailer } from "@doxahq/auth";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OutboxAuthMailer } from "../../src/services/auth/outbox-auth-mailer";

const env = {
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  BETTER_AUTH_SECRET: "email-password-secret-for-tests-only",
  BETTER_AUTH_URL: "https://api.doxa.so",
  WEB_ORIGIN: "https://doxa.so",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

afterEach(() => {
  vi.restoreAllMocks();
});

function recordingMailer() {
  const verification: AuthEmail[] = [];
  const reset: AuthEmail[] = [];
  const mailer: AuthMailer = {
    sendVerificationEmail: async (email) => void verification.push(email),
    sendResetPasswordEmail: async (email) => void reset.push(email),
  };
  return { mailer, verification, reset };
}

function post(path: string, body: unknown): Request {
  return new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.WEB_ORIGIN },
    body: JSON.stringify(body),
  });
}

function storedUser(emailVerified: boolean) {
  const now = new Date();
  return {
    id: "user-1", name: "Ada", email: EMAIL, emailVerified,
    image: null, createdAt: now, updatedAt: now,
  };
}

/** Replaces only the database boundary; hashing, tokens and links run for real. */
async function withExistingUser(auth: ReturnType<typeof createAuth>, emailVerified: boolean) {
  const context = await auth.$context;
  const user = storedUser(emailVerified);
  const now = new Date();
  const account = {
    id: "account-1", userId: user.id, providerId: "credential", accountId: user.id,
    password: await context.password.hash(PASSWORD), createdAt: now, updatedAt: now,
  };
  vi.spyOn(context.internalAdapter, "findUserByEmail").mockImplementation(async (email) =>
    email === EMAIL ? { user, accounts: [account] } : null,
  );
  vi.spyOn(context.internalAdapter, "findAccounts").mockResolvedValue([account]);
  const createSession = vi.spyOn(context.internalAdapter, "createSession");
  return { context, createSession };
}

describe("email and password sign-in", () => {
  test("is off when the auth instance has no mailer", async () => {
    const auth = createAuth(env);
    const response = await auth.handler(
      post("/sign-up/email", { name: "Ada", email: EMAIL, password: PASSWORD }),
    );
    expect(response.ok).toBe(false);
  });

  test("sign-up sends a verification link and starts no session", async () => {
    const { mailer, verification } = recordingMailer();
    const auth = createAuth(env, undefined, undefined, { mailer });
    const context = await auth.$context;
    vi.spyOn(context.internalAdapter, "findUserByEmail").mockResolvedValue(null);
    vi.spyOn(context.internalAdapter, "createUser").mockImplementation(async (data) => ({
      ...storedUser(false), ...data, id: "user-1",
    }) as never);
    vi.spyOn(context.internalAdapter, "linkAccount").mockImplementation(async (data) => ({
      id: "account-1", createdAt: new Date(), updatedAt: new Date(), ...data,
    }) as never);
    const createSession = vi.spyOn(context.internalAdapter, "createSession");

    const response = await auth.handler(post("/sign-up/email", {
      name: "Ada", email: EMAIL, password: PASSWORD,
      callbackURL: "https://doxa.so/login?redirect=%2Fdashboard",
    }));

    expect(response.status).toBe(200);
    expect(createSession).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie().some((cookie) => cookie.includes("session_token=") && !cookie.includes("Max-Age=0"))).toBe(false);
    expect(verification).toHaveLength(1);
    const link = new URL(verification[0].url);
    expect(verification[0]).toMatchObject({ userId: "user-1", email: EMAIL });
    expect(link.origin + link.pathname).toBe("https://api.doxa.so/api/auth/verify-email");
    expect(link.searchParams.get("token")).toBeTruthy();
    expect(link.searchParams.get("callbackURL")).toBe("https://doxa.so/login?redirect=%2Fdashboard");
  });

  test("refuses a password shorter than 8 characters", async () => {
    const { mailer, verification } = recordingMailer();
    const auth = createAuth(env, undefined, undefined, { mailer });
    const context = await auth.$context;
    const createUser = vi.spyOn(context.internalAdapter, "createUser");

    const response = await auth.handler(post("/sign-up/email", { name: "Ada", email: EMAIL, password: "short" }));

    expect(response.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
    expect(verification).toHaveLength(0);
  });

  test("an unverified account cannot sign in and gets a new verification link", async () => {
    const { mailer, verification } = recordingMailer();
    const auth = createAuth(env, undefined, undefined, { mailer });
    const { createSession } = await withExistingUser(auth, false);

    const response = await auth.handler(post("/sign-in/email", { email: EMAIL, password: PASSWORD }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(createSession).not.toHaveBeenCalled();
    expect(verification).toHaveLength(1);
  });

  test("a verified account signs in with the right password only", async () => {
    const { mailer } = recordingMailer();
    const auth = createAuth(env, undefined, undefined, { mailer });
    const { createSession } = await withExistingUser(auth, true);
    createSession.mockImplementation(async (userId) => {
      const now = new Date();
      return {
        id: "session-1", token: "token-1", userId, createdAt: now, updatedAt: now,
        expiresAt: new Date(now.getTime() + 60_000), ipAddress: null, userAgent: null,
      };
    });

    const wrong = await auth.handler(post("/sign-in/email", { email: EMAIL, password: "not the password" }));
    expect(wrong.status).toBe(401);
    expect(createSession).not.toHaveBeenCalled();

    const right = await auth.handler(post("/sign-in/email", { email: EMAIL, password: PASSWORD }));
    expect(right.status).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  test("a reset request sends a reset link for a known address only", async () => {
    const { mailer, reset } = recordingMailer();
    const auth = createAuth(env, undefined, undefined, { mailer });
    const { context } = await withExistingUser(auth, true);
    vi.spyOn(context.internalAdapter, "findVerificationValue").mockResolvedValue(null);
    vi.spyOn(context.internalAdapter, "createVerificationValue").mockImplementation(async (data) => ({
      id: "verification-1", createdAt: new Date(), updatedAt: new Date(), ...data,
    }) as never);
    const redirectTo = "https://doxa.so/reset-password";

    const known = await auth.handler(post("/request-password-reset", { email: EMAIL, redirectTo }));
    const unknown = await auth.handler(post("/request-password-reset", { email: "nobody@example.com", redirectTo }));

    // The same answer for both, so the endpoint does not reveal which addresses have accounts.
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json());
    expect(reset).toHaveLength(1);
    const link = new URL(reset[0].url);
    expect(link.pathname.startsWith("/api/auth/reset-password/")).toBe(true);
    expect(link.searchParams.get("callbackURL")).toBe(redirectTo);
  });
});

describe("OutboxAuthMailer", () => {
  test("queues each link once, with a dedupe key that does not contain the token", async () => {
    const enqueue = vi.fn(async () => "queued" as const);
    const mailer = new OutboxAuthMailer(() => ({ enqueue }));
    const url = "https://api.doxa.so/api/auth/verify-email?token=secret-token&callbackURL=%2F";

    await mailer.sendVerificationEmail({ userId: "user-1", email: EMAIL, url });
    await mailer.sendResetPasswordEmail({ userId: "user-1", email: EMAIL, url });

    const [[verifyKind, verifyProps, recipient, verifyKey], [resetKind, resetProps, , resetKey]] =
      enqueue.mock.calls as unknown as [
        [{ name: string }, Record<string, unknown>, unknown, string],
        [{ name: string }, Record<string, unknown>, unknown, string],
      ];
    expect(verifyKind.name).toBe("verify-email");
    expect(verifyProps).toEqual({ verifyUrl: url, expiresInHours: 24 });
    expect(recipient).toEqual({ email: EMAIL, userId: "user-1" });
    expect(resetKind.name).toBe("reset-password");
    expect(resetProps).toEqual({ resetUrl: url, expiresInMinutes: 60 });
    expect(verifyKey).toMatch(/^verify-email:[0-9a-f]{64}$/);
    expect(resetKey).toMatch(/^reset-password:[0-9a-f]{64}$/);
    expect(verifyKey).not.toContain("secret-token");
  });
});
