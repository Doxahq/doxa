import { isOAuthScope, type OAuthScope } from "@doxahq/contracts/agent-access";
import type { ScopeChallengeHandler } from "@modelcontextprotocol/server";
import { expandScopes } from "@doxahq/api/services/agent-access/scopes";

/**
 * Spec v2 §9: the SDK's per-tool step-up (`scopeChallenge`, SDK 2.1+). The
 * SDK runs it on the parsed `tools/call` before the tool and answers `403`
 * with `WWW-Authenticate: Bearer error="insufficient_scope"`. The challenge
 * names only the scope this tool needs: SDK clients add it to the scopes
 * they hold, so the user approves one new scope, not the full set again.
 */
export function scopeChallengeFor(requiredScope: OAuthScope): ScopeChallengeHandler {
  return ({ authInfo }) => {
    // No token: the OAuth resource server has already answered 401.
    if (authInfo === undefined || grantsScope(authInfo.scopes, requiredScope)) return undefined;
    return {
      scopes: [requiredScope],
      errorDescription: `This tool needs the ${requiredScope} scope.`,
    };
  };
}

/** Counts implied scopes: `publish` grants `docs:read`, for example. */
export function grantsScope(granted: readonly string[], required: OAuthScope): boolean {
  return expandScopes(granted.filter(isOAuthScope)).has(required);
}
