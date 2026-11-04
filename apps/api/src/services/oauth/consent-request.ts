import {
  OAUTH_SCOPES,
  isOAuthScope,
  type AgentConsentClient,
  type OAuthScope,
} from "@doxahq/contracts/agent-access";
import type { PendingConsent } from "./pending-consent-store";

export const OFFLINE_ACCESS_SCOPE = "offline_access";

const CLIENT_NAME_MAX_LENGTH = 200;

/**
 * The scopes the consent page offers. A client that asks for no Doxa scope
 * is offered the read scopes only (SEC-013): one click must not give an
 * unknown agent write, publish and domain access. It can ask for more
 * scopes later through the MCP scope challenge.
 */
export function offeredScopes(requested: readonly string[]): OAuthScope[] {
  const known = [...new Set(requested.filter(isOAuthScope))];
  return known.length > 0 ? known : OAUTH_SCOPES.filter(isReadScope);
}

/** A scope that only reads. */
export function isReadScope(scope: OAuthScope): boolean {
  return scope.endsWith(":read");
}

export function wantsOfflineAccess(requested: readonly string[]): boolean {
  return requested.includes(OFFLINE_ACCESS_SCOPE);
}

/** The name to show and to snapshot on the grant. A registered name is self-declared. */
export function clientDisplayName(consent: PendingConsent): string {
  const name = consent.client.clientName?.trim() || consent.client.clientId;
  return name.slice(0, CLIENT_NAME_MAX_LENGTH);
}

/**
 * A client ID that is an https URL is a client ID metadata document: the
 * provider fetched it from that domain, so its identity is verified.
 */
export function clientMetadataUrl(clientId: string): string | null {
  if (!URL.canParse(clientId)) return null;
  return new URL(clientId).protocol === "https:" ? clientId : null;
}

export function describeConsentClient(consent: PendingConsent): AgentConsentClient {
  const metadataUrl = clientMetadataUrl(consent.client.clientId);
  return {
    name: clientDisplayName(consent),
    metadataUrl,
    verified: metadataUrl !== null,
    redirectHost: redirectHost(consent.authRequest.redirectUri),
  };
}

// Native apps use custom schemes with no host; show the whole URI then.
function redirectHost(redirectUri: string): string {
  if (!URL.canParse(redirectUri)) return redirectUri;
  return new URL(redirectUri).host || redirectUri;
}
