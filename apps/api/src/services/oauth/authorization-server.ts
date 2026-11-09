import {
  OAuthAuthorizationServer,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { OAUTH_SCOPES } from "@doxahq/contracts/agent-access";
import {
  requireOAuthConfig,
  type OAuthEnv,
  type OAuthServerConfig,
  type OAuthSettings,
} from "./oauth-config";

/** The provider helpers this app uses; tests inject a fake of this shape. */
export type OAuthApi = Pick<
  OAuthHelpers,
  | "parseAuthRequest"
  | "lookupClient"
  | "completeAuthorization"
  | "listUserGrants"
  | "revokeGrant"
>;

const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
const REFRESH_TOKEN_IDLE_TTL_SECONDS = 14 * 24 * 3600;
/**
 * Dynamically registered clients expire after this (the provider default is
 * 90 days). Each registration is a Valkey record, so unused ones must not
 * pile up (SEC-008). A client in use renews at half of this on a token
 * request, and it is longer than the refresh token idle time, so a working
 * client never loses its registration.
 */
const CLIENT_REGISTRATION_TTL_SECONDS = 30 * 24 * 3600;

export const AUTHORIZE_PATH = "/oauth/authorize";
export const METADATA_PATH = "/.well-known/oauth-authorization-server";

export function createAuthorizationServer(
  config: OAuthServerConfig,
): OAuthAuthorizationServer<OAuthEnv> {
  return new OAuthAuthorizationServer<OAuthEnv>({
    issuer: config.issuer,
    resources: [config.mcpResource],
    authorizeEndpoint: `${config.issuer}${AUTHORIZE_PATH}`,
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...OAUTH_SCOPES, "offline_access"],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SECONDS,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
  });
}

let cached:
  | { readonly key: string; readonly server: OAuthAuthorizationServer<OAuthEnv> }
  | undefined;

/**
 * The provider checks its options in the constructor, and the options come
 * from env vars, so the server is built on first use and rebuilt only when
 * those vars change.
 */
export function authorizationServerFor(
  config: OAuthServerConfig,
): OAuthAuthorizationServer<OAuthEnv> {
  const key = `${config.issuer}|${config.mcpResource}`;
  if (cached?.key !== key) {
    cached = { key, server: createAuthorizationServer(config) };
  }
  return cached.server;
}

export function oauthApiFromEnv(env: OAuthSettings): OAuthApi {
  const { config, env: oauthEnv } = requireOAuthConfig(env);
  return authorizationServerFor(config).getOAuthApi(oauthEnv);
}

/** Paths the provider serves itself. `/oauth/authorize` is ours: the consent UI. */
export function isOAuthProviderPath(pathname: string): boolean {
  // Hono matches `/oauth/authorize/` too (strict: false), so compare without it.
  const path = pathname.replace(/\/+$/, "");
  if (path === METADATA_PATH) return true;
  return path.startsWith("/oauth/") && path !== AUTHORIZE_PATH;
}
