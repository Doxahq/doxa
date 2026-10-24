import type { Env } from "../../env";

export interface OAuthServerConfig {
  readonly issuer: string;
  readonly mcpResource: string;
}

/** The env entries OAuth reads; each is optional on a deployment. */
export type OAuthSettings = Pick<Env, "OAUTH_KV" | "OAUTH_ISSUER" | "MCP_RESOURCE_URL">;

/** The env once every OAuth binding and var is present. The provider reads `OAUTH_KV`. */
export interface OAuthEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_ISSUER: string;
  MCP_RESOURCE_URL: string;
}

export type OAuthConfigResolution =
  | { readonly configured: true; readonly env: OAuthEnv; readonly config: OAuthServerConfig }
  | { readonly configured: false; readonly missing: readonly string[] };

/**
 * Thrown when an OAuth path is used on a deployment without OAuth config.
 * Routes answer `503`; the rest of the API keeps working.
 */
export class OAuthNotConfiguredError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`OAuth is not configured. Missing: ${missing.join(", ")}.`);
    this.name = "OAuthNotConfiguredError";
  }
}

export function resolveOAuthConfig(env: OAuthSettings): OAuthConfigResolution {
  const missing = missingOAuthSettings(env);
  if (!isOAuthEnv(env) || missing.length > 0) {
    return { configured: false, missing };
  }
  return {
    configured: true,
    env,
    config: {
      issuer: env.OAUTH_ISSUER.replace(/\/+$/, ""),
      mcpResource: env.MCP_RESOURCE_URL,
    },
  };
}

export function requireOAuthConfig(
  env: OAuthSettings,
): Extract<OAuthConfigResolution, { configured: true }> {
  const resolution = resolveOAuthConfig(env);
  if (!resolution.configured) {
    throw new OAuthNotConfiguredError(resolution.missing);
  }
  return resolution;
}

function isOAuthEnv(env: OAuthSettings): env is OAuthSettings & OAuthEnv {
  return (
    env.OAUTH_KV !== undefined &&
    typeof env.OAUTH_ISSUER === "string" &&
    typeof env.MCP_RESOURCE_URL === "string"
  );
}

function missingOAuthSettings(env: OAuthSettings): string[] {
  const missing: string[] = [];
  if (env.OAUTH_KV === undefined) missing.push("OAUTH_KV");
  if (!isAbsoluteUrl(env.OAUTH_ISSUER)) missing.push("OAUTH_ISSUER");
  if (!isAbsoluteUrl(env.MCP_RESOURCE_URL)) missing.push("MCP_RESOURCE_URL");
  return missing;
}

function isAbsoluteUrl(value: string | undefined): boolean {
  return typeof value === "string" && URL.canParse(value);
}
