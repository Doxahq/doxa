import type { AuthRequest, GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { ProjectDto } from "@doxahq/contracts";
import { vi } from "vitest";
import type { MembershipProjectAccessPolicy } from "../../../src/services/agent-access/membership-project-access-policy";
import type { ProjectAccessPolicy } from "../../../src/services/agent-access/project-access-policy";
import { membershipPolicy } from "../../support/in-memory-project-access";
import type { OAuthApi } from "../../../src/services/oauth/authorization-server";
import { ConsentService } from "../../../src/services/oauth/consent-service";
import type {
  PendingConsent,
  PendingConsentStore,
} from "../../../src/services/oauth/pending-consent-store";
import type { ProductAnalytics } from "@doxahq/analytics";

export const OWNER = "owner-user";
export const OTHER = "other-user";
export const PROJECT_A = "11111111-1111-4111-8111-111111111111";
export const PROJECT_B = "22222222-2222-4222-8222-222222222222";
export const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
export const GRANT_REF = "44444444-4444-4444-8444-444444444444";
export const CONSENT_ID = "c".repeat(43);
export const NOW = new Date("2026-10-04T12:00:00.000Z");
export const ISSUER = "https://api.doxa.test";
export const MCP_RESOURCE = "https://mcp.doxa.test/mcp";

/** A GrantsService without agent tokens. */
export const agentTokenDeps = {
  agentTokens: { listActive: async () => [], revoke: async () => false },
  now: () => NOW,
};

export function authRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    responseType: "code",
    clientId: "client-abc",
    redirectUri: "http://127.0.0.1:9999/callback",
    scope: ["docs:read", "docs:write"],
    state: "state-1",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    resource: MCP_RESOURCE,
    issuer: ISSUER,
    ...overrides,
  };
}

export function pendingConsent(overrides: Partial<PendingConsent> = {}): PendingConsent {
  return {
    authRequest: authRequest(),
    client: { clientId: "client-abc", clientName: "Claude Code" },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

export class MemoryConsentStore implements PendingConsentStore {
  readonly consents = new Map<string, PendingConsent>();

  async save(id: string, consent: PendingConsent): Promise<void> {
    this.consents.set(id, consent);
  }

  async find(id: string): Promise<PendingConsent | null> {
    return this.consents.get(id) ?? null;
  }

  async remove(id: string): Promise<void> {
    this.consents.delete(id);
  }
}

/** The real policy over fixed owners; projects are personal. */
export function ownerPolicy(
  owners: Record<string, string> = {
    [PROJECT_A]: OWNER,
    [PROJECT_B]: OWNER,
    [OTHER_PROJECT]: OTHER,
  },
): MembershipProjectAccessPolicy {
  return membershipPolicy(
    Object.fromEntries(Object.entries(owners).map(([id, owner]) => [id, { owner }])),
  );
}

export function fakeOAuthApi(overrides: Partial<OAuthApi> = {}) {
  return {
    parseAuthRequest: vi.fn<OAuthApi["parseAuthRequest"]>(
      overrides.parseAuthRequest ?? (async () => authRequest()),
    ),
    lookupClient: vi.fn<OAuthApi["lookupClient"]>(
      overrides.lookupClient ??
        (async (clientId) => ({
          clientId,
          clientName: "Claude Code",
          redirectUris: ["http://127.0.0.1:9999/callback"],
          tokenEndpointAuthMethod: "none",
        })),
    ),
    completeAuthorization: vi.fn<OAuthApi["completeAuthorization"]>(
      overrides.completeAuthorization ??
        (async () => ({ redirectTo: "http://127.0.0.1:9999/callback?code=abc&state=state-1" })),
    ),
    listUserGrants: vi.fn<OAuthApi["listUserGrants"]>(
      overrides.listUserGrants ?? (async () => ({ items: [] })),
    ),
    revokeGrant: vi.fn<OAuthApi["revokeGrant"]>(overrides.revokeGrant ?? (async () => undefined)),
  };
}

export function consentService(
  store: PendingConsentStore,
  oauth: Pick<OAuthApi, "completeAuthorization"> = fakeOAuthApi(),
  now: () => Date = () => NOW,
  projects: ProjectAccessPolicy = ownerPolicy(),
  analytics?: ProductAnalytics,
): ConsentService {
  return new ConsentService({
    consents: store,
    oauth,
    projects,
    now,
    newGrantRef: () => GRANT_REF,
    ...(analytics ? { analytics } : {}),
  });
}

export function grantSummary(overrides: Partial<GrantSummary> = {}): GrantSummary {
  return {
    id: "grant-1",
    clientId: "client-abc",
    userId: OWNER,
    scope: ["docs:read", "offline_access"],
    metadata: {
      clientName: "Claude Code",
      cimd: false,
      grantRef: GRANT_REF,
      projectScope: { kind: "all" },
    },
    createdAt: Math.floor(NOW.getTime() / 1000),
    ...overrides,
  };
}
