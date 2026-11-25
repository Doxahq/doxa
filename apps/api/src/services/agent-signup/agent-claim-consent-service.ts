import type {
  AgentClaimDetails,
  ApproveAgentClaimInput,
  OAuthScope,
} from "@doxahq/contracts/agent-access";
import type { ValidationIssue } from "@doxahq/contracts/validation";
import { secretsMatch } from "@doxahq/api-bridge";
import type { ProductAnalytics } from "@doxahq/analytics";
import type { Env } from "../../env";
import { productAnalyticsOf } from "../analytics/product-analytics";
import {
  AccountEmailRepository,
  AgentClaimRepository,
  type AccountEmailReader,
  type AgentClaimRecord,
  type AgentClaimStore,
} from "../../repositories/agent-claims";
import { AgentTokenRepository, type AgentTokenStore } from "../../repositories/agent-tokens";
import { dashboardActor } from "../agent-access/actor";
import { MembershipProjectAccessPolicy } from "../agent-access/membership-project-access-policy";
import type { ProjectAccessPolicy } from "../agent-access/project-access-policy";
import { analyticsClientLabel, offeredScopes } from "../oauth/consent-request";
import { projectScopeIssues, scopeIssues } from "../oauth/consent-validation";
import {
  APPROVED_CLAIM_REDEEM_SECONDS,
  MAX_ACTIVE_AGENT_TOKENS_PER_USER,
  MAX_USER_CODE_ATTEMPTS,
  requireAgentSignupConfig,
} from "./agent-signup-config";
import { sha256Hex, userCodeHash } from "./agent-signup-secrets";

export interface AgentClaimConsentDependencies {
  claims: AgentClaimStore;
  tokens: Pick<AgentTokenStore, "countActive">;
  accounts: AccountEmailReader;
  projects: ProjectAccessPolicy;
  now: () => Date;
  /** Product analytics. Absent: nothing is reported. */
  analytics?: ProductAnalytics;
}

export type AgentClaimLookup =
  | { readonly kind: "found"; readonly details: AgentClaimDetails }
  | { readonly kind: "not_found" };

export type AgentClaimApprovalResult =
  | { readonly kind: "approved" }
  | { readonly kind: "wrong_code"; readonly attemptsLeft: number }
  | { readonly kind: "account_mismatch" }
  | { readonly kind: "token_limit" }
  | { readonly kind: "rejected"; readonly issues: readonly ValidationIssue[] }
  | { readonly kind: "not_found" };

const NOT_FOUND = { kind: "not_found" } as const;

/** The browser side of the claim flow: the person checks the code and decides. */
export class AgentClaimConsentService {
  constructor(private readonly deps: AgentClaimConsentDependencies) {}

  static fromEnv(env: Env): AgentClaimConsentService {
    requireAgentSignupConfig(env);
    return new AgentClaimConsentService({
      claims: new AgentClaimRepository(env),
      tokens: new AgentTokenRepository(env),
      accounts: new AccountEmailRepository(env),
      projects: MembershipProjectAccessPolicy.fromEnv(env),
      now: () => new Date(),
      analytics: productAnalyticsOf(env),
    });
  }

  /** Records the first visit, so that the agent can see that the link opened. */
  async open(attemptToken: string): Promise<boolean> {
    const claim = await this.findLive(attemptToken);
    if (claim === null) return false;
    if (claim.openedAt === null) await this.deps.claims.markOpened(claim.id, this.deps.now());
    return true;
  }

  async details(attemptToken: string, userId: string): Promise<AgentClaimLookup> {
    const claim = await this.findLive(attemptToken);
    if (claim === null) return NOT_FOUND;
    const [projects, accountMatches] = await Promise.all([
      this.deps.projects.listAccessibleProjects(dashboardActor(userId)),
      this.accountMatches(claim, userId),
    ]);
    return {
      kind: "found",
      details: {
        clientName: claim.clientName,
        tokenName: claim.tokenName,
        requestedScopes: requestedScopes(claim),
        projects: projects.map(({ id, name, slug, team }) => ({ id, name, slug, team })),
        loginHint: claim.loginHint,
        accountMatches,
        expiresAt: claim.expiresAt.toISOString(),
      },
    };
  }

  async approve(input: ApproveAgentClaimInput, userId: string): Promise<AgentClaimApprovalResult> {
    const claim = await this.findLive(input.attemptToken);
    if (claim === null) return NOT_FOUND;
    if (!(await this.accountMatches(claim, userId))) return { kind: "account_mismatch" };

    // Checked first, so that a wrong form choice does not spend a code attempt.
    const issues = [
      ...scopeIssues(input.scopes, requestedScopes(claim)),
      ...(await projectScopeIssues(this.deps.projects, userId, input.projectScope)),
    ];
    if (issues.length > 0) return { kind: "rejected", issues };

    const codeCheck = await this.checkUserCode(claim, input);
    if (codeCheck !== null) return codeCheck;

    const now = this.deps.now();
    if ((await this.deps.tokens.countActive(userId, now)) >= MAX_ACTIVE_AGENT_TOKENS_PER_USER) {
      return { kind: "token_limit" };
    }
    const scopes = [...new Set(input.scopes)];
    const approved = await this.deps.claims.approve(
      claim.id,
      {
        userId,
        scopes,
        projectScope: input.projectScope,
        expiresAt: new Date(now.getTime() + APPROVED_CLAIM_REDEEM_SECONDS * 1000),
      },
      now,
    );
    if (!approved) return NOT_FOUND;
    // The approval grants the agent its token: the same fact as an OAuth consent.
    this.deps.analytics?.capture({
      name: "mcp_agent_connected",
      distinctId: userId,
      properties: { client: analyticsClientLabel({ clientName: claim.clientName }), scope_count: scopes.length },
    });
    return { kind: "approved" };
  }

  async deny(attemptToken: string, userId: string): Promise<boolean> {
    const claim = await this.findLive(attemptToken);
    if (claim === null || !(await this.accountMatches(claim, userId))) return false;
    return this.deps.claims.deny(claim.id, this.deps.now());
  }

  /** Null when the code is correct. The attempt is spent before the comparison. */
  private async checkUserCode(
    claim: AgentClaimRecord,
    input: ApproveAgentClaimInput,
  ): Promise<AgentClaimApprovalResult | null> {
    const used = await this.deps.claims.reserveCodeAttempt(claim.id, this.deps.now(), MAX_USER_CODE_ATTEMPTS);
    if (used === null) return NOT_FOUND;
    const presented = await userCodeHash(input.attemptToken, input.userCode);
    if (secretsMatch(presented, claim.userCodeHash)) return null;
    if (used >= MAX_USER_CODE_ATTEMPTS) {
      await this.deps.claims.lock(claim.id);
      return NOT_FOUND;
    }
    return { kind: "wrong_code", attemptsLeft: MAX_USER_CODE_ATTEMPTS - used };
  }

  private async accountMatches(claim: AgentClaimRecord, userId: string): Promise<boolean> {
    if (claim.loginHint === null) return true;
    const email = await this.deps.accounts.findEmail(userId);
    return email?.toLowerCase() === claim.loginHint;
  }

  private async findLive(attemptToken: string): Promise<AgentClaimRecord | null> {
    const claim = await this.deps.claims.findByAttemptTokenHash(await sha256Hex(attemptToken));
    if (claim === null || claim.status !== "pending" || claim.expiresAt <= this.deps.now()) return null;
    return claim;
  }
}

function requestedScopes(claim: AgentClaimRecord): OAuthScope[] {
  return offeredScopes(claim.requestedScopes);
}
