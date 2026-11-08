import type { ExecutionContext, IncomingRequestCfProperties, KVNamespace } from "@cloudflare/workers-types";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { withCloudflare } from "better-auth-cloudflare";
import {
  createDb,
  createGitHubIdentityStore,
  type DbEnv,
} from "@doxahq/db";
import {
  syncGitHubAccountIdentity,
  type GitHubAuthAccount,
} from "./github-identity";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-policy";

export interface AuthEnv extends DbEnv {
  AUTH_KV?: KVNamespace;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  AUTH_COOKIE_DOMAIN?: string;
  AUTH_COOKIE_PREFIX?: string;
  /** New accounts are refused unless this is exactly "true". */
  AUTH_SIGNUPS_ENABLED?: string;
  WEB_ORIGIN?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

type CfRequest = Request & { cf?: IncomingRequestCfProperties };

const SESSION_COOKIE_CACHE_MAX_AGE_SECONDS = 5 * 60;

export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 24 * 60 * 60;
export const RESET_PASSWORD_EXPIRES_IN_SECONDS = 60 * 60;

/** A link email for one recipient. `url` is the Better Auth link with its token. */
export interface AuthEmail {
  readonly userId: string;
  readonly email: string;
  readonly url: string;
}

/**
 * Sends the account emails of email and password sign-in. The API passes one
 * that queues them in the email outbox. Without it, nobody can sign up with a
 * password, because the account could never be verified.
 */
export interface AuthMailer {
  sendVerificationEmail(email: AuthEmail): Promise<void>;
  sendResetPasswordEmail(email: AuthEmail): Promise<void>;
}

export interface CreateAuthOptions {
  readonly mailer?: AuthMailer;
}

export function createAuth(
  env: AuthEnv,
  request?: Request,
  ctx?: ExecutionContext,
  options: CreateAuthOptions = {},
) {
  const { mailer } = options;
  const disableSignUp = env.AUTH_SIGNUPS_ENABLED?.trim() !== "true";
  const db = createDb(env);
  const cf = (request as CfRequest | undefined)?.cf ?? {};
  const githubIdentityStore = createGitHubIdentityStore(db);
  const synchronizeGitHubAccount = (account: GitHubAuthAccount) =>
    runIdentitySync(
      syncGitHubAccountIdentity({
        account,
        store: githubIdentityStore,
      }),
    );

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: getTrustedOrigins(env),
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: false,
        cf,
        kv: env.AUTH_KV,
      },
      {
        advanced: advancedOptions(env, ctx),
        rateLimit: {
          enabled: true,
          window: 60,
          max: 100,
          customRules: {
            "/sign-in/social": {
              window: 60,
              max: 30,
            },
            "/sign-in/email": {
              window: 60,
              max: 10,
            },
            "/sign-up/email": {
              window: 60,
              max: 5,
            },
            "/request-password-reset": {
              window: 60,
              max: 5,
            },
            "/send-verification-email": {
              window: 60,
              max: 5,
            },
          },
        },
      },
    ),
    database: drizzleAdapter(db, {
      provider: "pg",
    }),
    emailAndPassword: {
      enabled: Boolean(mailer),
      disableSignUp,
      requireEmailVerification: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_EXPIRES_IN_SECONDS,
      revokeSessionsOnPasswordReset: true,
      ...(mailer
        ? {
            sendResetPassword: ({ user, url }) =>
              mailer.sendResetPasswordEmail({ userId: user.id, email: user.email, url }),
          }
        : {}),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
      ...(mailer
        ? {
            sendVerificationEmail: ({ user, url }) =>
              mailer.sendVerificationEmail({ userId: user.id, email: user.email, url }),
          }
        : {}),
    },
    session: {
      deferSessionRefresh: true,
      cookieCache: {
        enabled: true,
        maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
        strategy: "compact",
      },
    },
    user: {
      additionalFields: {
        githubLogin: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      // The provider options do not cover ID token sign-in, so this hook is
      // the check that holds for every path that creates a user.
      ...(disableSignUp ? { user: { create: { before: refuseNewUser } } } : {}),
      account: {
        create: {
          after: async (account) =>
            synchronizeGitHubAccount(account),
        },
        update: {
          after: async (account) =>
            synchronizeGitHubAccount(account),
        },
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        disableSignUp,
      },
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        disableSignUp,
      },
    },
    plugins: [],
  });
}

async function refuseNewUser(): Promise<never> {
  throw new APIError("FORBIDDEN", { message: "New sign-ups are closed." });
}

async function runIdentitySync(
  task: Promise<void>,
): Promise<void> {
  await task.catch((error: unknown) => {
    console.error("GitHub identity synchronization failed.", error);
  });
}

export type DoxaAuth = ReturnType<typeof createAuth>;

function advancedOptions(
  env: Pick<AuthEnv, "AUTH_COOKIE_DOMAIN" | "AUTH_COOKIE_PREFIX">,
  ctx: ExecutionContext | undefined,
): BetterAuthOptions["advanced"] | undefined {
  const cookieDomain = env.AUTH_COOKIE_DOMAIN?.trim();
  const cookiePrefix = env.AUTH_COOKIE_PREFIX?.trim();
  if (!cookieDomain && !cookiePrefix && !ctx) return undefined;

  return {
    // A dev hostname still receives parent-domain production cookies.
    ...(cookiePrefix ? { cookiePrefix } : {}),
    ...(cookieDomain
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: cookieDomain,
          },
        }
      : {}),
    ...(ctx
      ? {
          backgroundTasks: {
            handler: (task: Promise<unknown>) => ctx.waitUntil(task),
          },
        }
      : {}),
  };
}

/** The local dashboard dev server. */
const LOCAL_WEB_ORIGINS = ["http://localhost:3001", "http://127.0.0.1:3001"];

/**
 * Origins that Better Auth and the API CSRF check trust. The local dashboard
 * is trusted only when the API itself runs on a loopback host (SEC-019): a
 * deployed API must not accept localhost as a callback or CSRF origin. A
 * tunnel setup that needs it lists it in BETTER_AUTH_TRUSTED_ORIGINS.
 */
export function getTrustedOrigins(
  env: Pick<AuthEnv, "BETTER_AUTH_URL" | "WEB_ORIGIN" | "BETTER_AUTH_TRUSTED_ORIGINS">,
): string[] {
  return uniqueOrigins([
    env.BETTER_AUTH_URL,
    env.WEB_ORIGIN,
    ...(isLoopbackOrigin(env.BETTER_AUTH_URL) ? LOCAL_WEB_ORIGINS : []),
    ...splitOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS),
  ]);
}

function isLoopbackOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function splitOrigins(value: string | undefined): string[] {
  return value?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
}

function uniqueOrigins(origins: Array<string | undefined>): string[] {
  return Array.from(new Set(origins.filter((origin): origin is string => Boolean(origin))));
}
