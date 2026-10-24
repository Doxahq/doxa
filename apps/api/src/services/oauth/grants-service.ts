import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { isOAuthScope, type AgentGrantSummary } from "@doxahq/contracts/agent-access";
import type { Env } from "../../env";
import { noAgentActivity, type AgentActivityLookup } from "./agent-activity-lookup";
import { oauthApiFromEnv, type OAuthApi } from "./authorization-server";
import { agentGrantMetadataSchema, type AgentGrantMetadata } from "./grant-metadata";

export interface GrantsServiceDependencies {
  oauth: Pick<OAuthApi, "listUserGrants" | "revokeGrant">;
  activity: AgentActivityLookup;
}

export type GrantRevocation = { readonly kind: "revoked" } | { readonly kind: "not_found" };

export const MAX_LISTED_GRANTS = 200;

const PAGE_SIZE = 100;
const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

interface AgentGrant {
  readonly summary: GrantSummary;
  readonly metadata: AgentGrantMetadata;
}

/** Spec 6.7: the user's connected agents. */
export class GrantsService {
  constructor(private readonly deps: GrantsServiceDependencies) {}

  static fromEnv(env: Env): GrantsService {
    return new GrantsService({ oauth: oauthApiFromEnv(env), activity: noAgentActivity });
  }

  async list(userId: string): Promise<AgentGrantSummary[]> {
    const grants: AgentGrant[] = [];
    for await (const grant of this.agentGrants(userId)) {
      grants.push(grant);
      if (grants.length >= MAX_LISTED_GRANTS) break;
    }
    const activity = await this.deps.activity.lastActivityByGrantRef(
      userId,
      grants.map((grant) => grant.metadata.grantRef),
    );
    return grants
      .map((grant) => toSummary(grant, activity.get(grant.metadata.grantRef) ?? null))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revoke(userId: string, grantId: string): Promise<GrantRevocation> {
    // The provider's revoke is a silent no-op for an unknown grant.
    if (!(await this.ownsGrant(userId, grantId))) return { kind: "not_found" };
    await this.deps.oauth.revokeGrant(grantId, userId);
    return { kind: "revoked" };
  }

  private async ownsGrant(userId: string, grantId: string): Promise<boolean> {
    if (!GRANT_ID_PATTERN.test(grantId)) return false;
    for await (const summary of this.grantSummaries(userId)) {
      if (summary.id === grantId) return true;
    }
    return false;
  }

  /** Grants made by consent. Others (none exist today) cannot be described. */
  private async *agentGrants(userId: string): AsyncGenerator<AgentGrant> {
    for await (const summary of this.grantSummaries(userId)) {
      const metadata = agentGrantMetadataSchema.safeParse(summary.metadata);
      if (metadata.success) yield { summary, metadata: metadata.data };
    }
  }

  private async *grantSummaries(userId: string): AsyncGenerator<GrantSummary> {
    let cursor: string | undefined;
    do {
      const page = await this.deps.oauth.listUserGrants(userId, { limit: PAGE_SIZE, cursor });
      yield* page.items;
      cursor = page.cursor;
    } while (cursor !== undefined);
  }
}

function toSummary(grant: AgentGrant, lastActivity: Date | null): AgentGrantSummary {
  return {
    grantId: grant.summary.id,
    clientName: grant.metadata.clientName,
    scopes: grant.summary.scope.filter(isOAuthScope),
    projectScope: grant.metadata.projectScope,
    createdAt: new Date(grant.summary.createdAt * 1000).toISOString(),
    lastActivityAt: lastActivity?.toISOString() ?? null,
  };
}
