import { assertStrongSecret } from "@doxahq/api-bridge";
import { z } from "zod";
import type { Env } from "../../env";

/** Env keys that hold bindings. Everything else in `Env` is a string variable. */
export type BindingName =
  | "DOCS_BUCKET"
  | "AUTH_KV"
  | "OAUTH_KV"
  | "GENERATION_QUEUE"
  | "EMAIL_QUEUE"
  | "DOCS_CACHE_INVALIDATOR"
  | "PRERENDER_QUEUE"
  | "AGENT_CONTAINER"
  | "MODEL_TOKEN_BROKER"
  | "HYPERDRIVE"
  | "HYPERDRIVE_CACHE_DISABLED"
  | "BILLING_PAYMENTS"
  | "PRODUCT_ANALYTICS";

/** The string variables of the API, as the Worker gets them from wrangler.json and secrets. */
export type ApiVars = Omit<Env, BindingName>;

const requiredString = z.string().trim().min(1);

/**
 * Required variables and the ones with a closed set of values. Every other
 * variable passes through as a string, as Workers pass `vars`.
 */
const apiVarsSchema = z
  .object({
    BETTER_AUTH_SECRET: requiredString,
    BETTER_AUTH_URL: z.url(),
    // The only CORS origin with credentials. Without it the API refuses every
    // cross-origin call, so the origin refuses to start instead (SEC-020).
    WEB_ORIGIN: z.url(),
    GOOGLE_CLIENT_ID: requiredString,
    GOOGLE_CLIENT_SECRET: requiredString,
    GITHUB_CLIENT_ID: requiredString,
    GITHUB_CLIENT_SECRET: requiredString,
    DATABASE_URL: requiredString,
    GENERATION_MODE: z.enum(["starter-dev", "container-inline", "queue"]).optional(),
    DOXA_GENERATION_PROFILE: z.enum(["fast-mvp", "full-prod"]).optional(),
    DOXA_RUNTIME_ENVIRONMENT: z.enum(["development", "production"]).optional(),
  })
  .catchall(z.string());

/** Where the docs bucket comes from: R2 over S3 in AWS, the local Wrangler state in development. */
export type DocsBucketSource =
  | { kind: "s3"; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }
  | { kind: "local"; wranglerConfigPath: string; persistPath: string };

export interface NodeServerConfig {
  /**
   * Address to listen on. The loopback address by default: cloudflared in the
   * same task is the only client. A local container run sets 0.0.0.0.
   */
  host: string;
  port: number;
  originKey: string;
  bridge: { baseUrl: string; key: string };
  valkeyUrl: string;
  docsBucket: DocsBucketSource;
  pgPoolMax: number;
  /** How long shutdown waits for open requests and background tasks. */
  shutdownGraceMs: number;
  /** Refuse fetches to non-public addresses, as the production Worker does. Off in local development. */
  strictPublicFetch: boolean;
}

const serverSchema = z.object({
  HOST: z.union([z.ipv4(), z.ipv6()]).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8786),
  ORIGIN_SHARED_SECRET: z.string(),
  BRIDGE_URL: z.url(),
  BRIDGE_SHARED_SECRET: z.string(),
  VALKEY_URL: z.string().regex(/^rediss?:\/\//, "VALKEY_URL must start with redis:// or rediss://"),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  // ECS gives 120 s after SIGTERM. Keep a margin for the process to exit.
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(115_000).default(110_000),
  STRICT_PUBLIC_FETCH: z.enum(["true", "false"]).default("true"),
  DOCS_BUCKET_SOURCE: z.enum(["s3", "local"]).default("s3"),
  R2_ENDPOINT: z.url().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  WRANGLER_CONFIG_PATH: z.string().optional(),
  WRANGLER_PERSIST_PATH: z.string().optional(),
});

/** Reads and checks the server settings. A missing or weak setting fails start-up. */
export function readServerConfig(source: Record<string, string | undefined>): NodeServerConfig {
  const parsed = serverSchema.parse(source);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    originKey: assertStrongSecret("ORIGIN_SHARED_SECRET", parsed.ORIGIN_SHARED_SECRET),
    bridge: {
      baseUrl: parsed.BRIDGE_URL,
      key: assertStrongSecret("BRIDGE_SHARED_SECRET", parsed.BRIDGE_SHARED_SECRET),
    },
    valkeyUrl: parsed.VALKEY_URL,
    docsBucket: docsBucketSourceOf(parsed),
    pgPoolMax: parsed.PG_POOL_MAX,
    shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
    strictPublicFetch: parsed.STRICT_PUBLIC_FETCH === "true",
  };
}

function docsBucketSourceOf(parsed: z.infer<typeof serverSchema>): DocsBucketSource {
  if (parsed.DOCS_BUCKET_SOURCE === "local") {
    return {
      kind: "local",
      wranglerConfigPath: required(parsed.WRANGLER_CONFIG_PATH, "WRANGLER_CONFIG_PATH"),
      persistPath: required(parsed.WRANGLER_PERSIST_PATH, "WRANGLER_PERSIST_PATH"),
    };
  }
  return {
    kind: "s3",
    endpoint: required(parsed.R2_ENDPOINT, "R2_ENDPOINT"),
    bucket: required(parsed.R2_BUCKET, "R2_BUCKET"),
    accessKeyId: required(parsed.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID"),
    secretAccessKey: required(parsed.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY"),
  };
}

/**
 * Reads the API variables. Strings only: bindings come from the runtime.
 * The server's own settings (the shared keys, R2 and Valkey credentials) and
 * the AWS and ECS variables of the task stay out: the API code gets only
 * what the Worker would get.
 */
export function readApiVars(source: Record<string, unknown>): ApiVars {
  const vars = apiVarsSchema.parse(
    Object.fromEntries(
      Object.entries(source).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && !isServerOnlyVariable(entry[0]),
      ),
    ),
  );
  assertNoDevelopmentFlags(vars);
  return vars;
}

/**
 * Development switches that weaken a check. Each guard also checks the
 * request origin today, but production must not depend on that one layer
 * (SEC-035).
 */
const DEVELOPMENT_FLAGS: ReadonlyArray<readonly [string, (value: string) => boolean]> = [
  ["LOCAL_DEV_USER_ID", (value) => value.trim().length > 0],
  ["LOCAL_GITHUB_TOKEN", (value) => value.trim().length > 0],
  ["ALLOW_INTERNAL_HTTP", (value) => value === "true"],
  ["DEV_ADMIN_ENABLED", (value) => value === "true"],
  ["ALLOW_INSECURE_GITHUB_WEBHOOKS", (value) => value === "true"],
];

/**
 * A production origin (NODE_ENV=production, as the image and Terraform set)
 * refuses to start with a development switch on. A local container run that
 * needs one sets DOXA_RUNTIME_ENVIRONMENT=development.
 */
function assertNoDevelopmentFlags(vars: Record<string, string | undefined>): void {
  if (vars.NODE_ENV !== "production" || vars.DOXA_RUNTIME_ENVIRONMENT === "development") return;
  const enabled = DEVELOPMENT_FLAGS.filter(([name, isOn]) => {
    const value = vars[name];
    return value !== undefined && isOn(value);
  }).map(([name]) => name);
  if (enabled.length > 0) {
    throw new Error(`Development flags are not allowed in production: ${enabled.join(", ")}.`);
  }
}

const SERVER_ONLY_VARIABLES: ReadonlySet<string> = new Set(Object.keys(serverSchema.shape));

function isServerOnlyVariable(name: string): boolean {
  return SERVER_ONLY_VARIABLES.has(name) || name.startsWith("AWS_") || name.startsWith("ECS_");
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
