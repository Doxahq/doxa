import { authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import {
  AGENT_GRANT_PROPS_VERSION,
  type AgentConsentDetails,
  type AgentGrantProps,
  type ApproveAgentConsentInput,
} from "@doxahq/contracts/agent-access";
import type { ValidationIssue } from "@doxahq/contracts/validation";
import type { ProductAnalytics } from "@doxahq/analytics";
import type { Env } from "../../env";
import { productAnalyticsOf } from "../analytics/product-analytics";
import { dashboardActor } from "../agent-access/actor";
import { MembershipProjectAccessPolicy } from "../agent-access/membership-project-access-policy";
import type { ProjectAccessPolicy } from "../agent-access/project-access-policy";
import { oauthApiFromEnv, type OAuthApi } from "./authorization-server";
import {
  OFFLINE_ACCESS_SCOPE,
  analyticsClientLabel,
  clientDisplayName,
  clientMetadataUrl,
  describeConsentClient,
  offeredScopes,
  wantsOfflineAccess,
} from "./consent-request";
import type { AgentGrantMetadata } from "./grant-metadata";
import { projectScopeIssues, scopeIssues } from "./consent-validation";
import { requireOAuthConfig } from "./oauth-config";
import {
  KvPendingConsentStore,
  PENDING_CONSENT_TTL_SECONDS,
  isConsentId,
  type PendingConsent,
  type PendingConsentStore,
} from "./pending-consent-store";

export interface ConsentServiceDependencies {
  consents: PendingConsentStore;
  oauth: Pick<OAuthApi, "completeAuthorization">;
  projects: ProjectAccessPolicy;
  now: () => Date;
  newGrantRef: () => string;
  /** Product analytics. Absent: nothing is reported. */
  analytics?: ProductAnalytics;
}

export type ConsentLookup =
  | { readonly kind: "found"; readonly details: AgentConsentDetails }
  | { readonly kind: "not_found" };

export type ConsentApproval =
  | { readonly kind: "approved"; readonly redirectTo: string }
  | { readonly kind: "rejected"; readonly issues: readonly ValidationIssue[] }
  | { readonly kind: "not_found" };

export type ConsentDenial =
  | { readonly kind: "denied"; readonly redirectTo: string }
  | { readonly kind: "not_found" };

const NOT_FOUND = { kind: "not_found" } as const;

/** Spec 6.5 steps 6 to 9. A pending consent is not bound to a user until approval. */
export class ConsentService {
  constructor(private readonly deps: ConsentServiceDependencies) {}

  static fromEnv(env: Env): ConsentService {
    const { env: oauthEnv } = requireOAuthConfig(env);
    return new ConsentService({
      consents: new KvPendingConsentStore(oauthEnv.OAUTH_KV),
      oauth: oauthApiFromEnv(env),
      projects: MembershipProjectAccessPolicy.fromEnv(env),
      now: () => new Date(),
      newGrantRef: () => crypto.randomUUID(),
      analytics: productAnalyticsOf(env),
    });
  }

  async get(consentId: string, userId: string): Promise<ConsentLookup> {
    const consent = await this.findLive(consentId);
    if (consent === null) return NOT_FOUND;
    const projects = await this.deps.projects.listAccessibleProjects(dashboardActor(userId));
    return {
      kind: "found",
      details: {
        consentId,
        client: describeConsentClient(consent),
        requestedScopes: offeredScopes(consent.authRequest.scope),
        // Spec §5: the picker groups the projects by team.
        projects: projects.map(({ id, name, slug, team }) => ({ id, name, slug, team })),
        expiresAt: expiresAt(consent).toISOString(),
      },
    };
  }

  async approve(
    consentId: string,
    userId: string,
    input: ApproveAgentConsentInput,
  ): Promise<ConsentApproval> {
    const consent = await this.findLive(consentId);
    if (consent === null) return NOT_FOUND;
    const issues = [
      ...scopeIssues(input.scopes, offeredScopes(consent.authRequest.scope)),
      ...(await projectScopeIssues(this.deps.projects, userId, input.projectScope)),
    ];
    if (issues.length > 0) return { kind: "rejected", issues };

    // Removed before the grant is made so the consent cannot be used twice.
    await this.deps.consents.remove(consentId);
    const { redirectTo } = await this.deps.oauth.completeAuthorization(
      this.authorization(consent, userId, input),
    );
    this.deps.analytics?.capture({
      name: "mcp_agent_connected",
      distinctId: userId,
      properties: { client: analyticsClientLabel(consent.client), scope_count: new Set(input.scopes).size },
    });
    return { kind: "approved", redirectTo };
  }

  async deny(consentId: string): Promise<ConsentDenial> {
    const consent = await this.findLive(consentId);
    if (consent === null) return NOT_FOUND;
    await this.deps.consents.remove(consentId);
    return {
      kind: "denied",
      redirectTo: authorizationErrorRedirect(consent.authRequest, "access_denied"),
    };
  }

  private authorization(consent: PendingConsent, userId: string, input: ApproveAgentConsentInput) {
    const clientName = clientDisplayName(consent);
    const grantRef = this.deps.newGrantRef();
    const props: AgentGrantProps = {
      version: AGENT_GRANT_PROPS_VERSION,
      grantRef,
      userId,
      clientName,
      projectScope: input.projectScope,
    };
    const metadata: AgentGrantMetadata = {
      clientName,
      cimd: clientMetadataUrl(consent.client.clientId) !== null,
      grantRef,
      projectScope: input.projectScope,
    };
    const scopes: string[] = [...new Set(input.scopes)];
    if (wantsOfflineAccess(consent.authRequest.scope)) scopes.push(OFFLINE_ACCESS_SCOPE);
    return { request: consent.authRequest, userId, scope: scopes, props, metadata };
  }

  private async findLive(consentId: string): Promise<PendingConsent | null> {
    if (!isConsentId(consentId)) return null;
    const consent = await this.deps.consents.find(consentId);
    // KV expiry is eventual; the stored time is the real deadline.
    if (consent === null || expiresAt(consent) <= this.deps.now()) return null;
    return consent;
  }
}

function expiresAt(consent: PendingConsent): Date {
  return new Date(Date.parse(consent.createdAt) + PENDING_CONSENT_TTL_SECONDS * 1000);
}
