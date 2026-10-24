import type { ExecutionContext, IncomingRequestCfProperties, KVNamespace } from "@cloudflare/workers-types";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
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

export interface AuthEnv extends DbEnv {
  AUTH_KV?: KVNamespace;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  AUTH_COOKIE_DOMAIN?: string;
  AUTH_COOKIE_PREFIX?: string;
  WEB_ORIGIN?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

type CfRequest = Request & { cf?: IncomingRequestCfProperties };

const SESSION_COOKIE_CACHE_MAX_AGE_SECONDS = 5 * 60;

export function createAuth(env: AuthEnv, request?: Request, ctx?: ExecutionContext) {
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
          },
        },
      },
    ),
    database: drizzleAdapter(db, {
      provider: "pg",
    }),
    emailAndPassword: {
      enabled: false,
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
      },
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    plugins: [],
  });
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

export function getTrustedOrigins(
  env: Pick<AuthEnv, "BETTER_AUTH_URL" | "WEB_ORIGIN" | "BETTER_AUTH_TRUSTED_ORIGINS">,
): string[] {
  return uniqueOrigins([
    env.BETTER_AUTH_URL,
    env.WEB_ORIGIN,
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    ...splitOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS),
  ]);
}

function splitOrigins(value: string | undefined): string[] {
  return value?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
}

function uniqueOrigins(origins: Array<string | undefined>): string[] {
  return Array.from(new Set(origins.filter((origin): origin is string => Boolean(origin))));
}
