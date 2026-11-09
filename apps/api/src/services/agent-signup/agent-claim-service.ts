import {
  isOAuthScope,
  projectScopeClaimSchema,
  type AgentIdentityRequest,
} from "@doxahq/contracts/agent-access";
import type { Env } from "../../env";
import {
  AgentClaimRepository,
  type AgentClaimRecord,
  type AgentClaimStore,
  type NewAgentToken,
} from "../../repositories/agent-claims";
import { toSafeErrorLog } from "../../http/error-log";
import { offeredScopes } from "../oauth/consent-request";
import { createAgentConnectedNotifier, type AgentConnectedNotifier } from "./agent-connected-notice";
import {
  AGENT_TOKEN_TTL_SECONDS,
  CLAIM_TTL_SECONDS,
  MAX_ACTIVE_AGENT_TOKENS_PER_USER,
  MAX_CLAIMS_PER_CLIENT_IP_PER_HOUR,
  MAX_CLAIMS_PER_LOGIN_HINT_AND_IP_PER_HOUR,
  MAX_CLAIMS_PER_LOGIN_HINT_PER_HOUR,
  POLL_INTERVAL_SECONDS,
  requireAgentSignupConfig,
} from "./agent-signup-config";
import {
  isClaimToken,
  newAgentToken,
  newAttemptToken,
  newClaimToken,
  newUserCode,
  sha256Hex,
  userCodeHash,
} from "./agent-signup-secrets";

const HOUR_MS = 3_600_000;
const DEFAULT_CLIENT_NAME = "Agent";
/** Small clock and network differences must not punish an agent that obeys the interval. */
const POLL_INTERVAL_TOLERANCE_MS = 1000;

export interface AgentClaimServiceDependencies {
  claims: AgentClaimStore;
  mcpResource: string;
  notifyConnected: AgentConnectedNotifier;
  now: () => Date;
  newId: () => string;
}

export interface AgentRegistrationContext {
  readonly clientIpKey: string | null;
  readonly webOrigin: string;
}

export interface AgentRegistrationGrant {
  readonly registrationId: string;
  readonly claimToken: string;
  readonly claimTokenExpires: string;
  readonly scopes: readonly string[];
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export type AgentRegistration =
  | { readonly kind: "registered"; readonly grant: AgentRegistrationGrant }
  | { readonly kind: "rate_limited" };

export type AgentPendingStage = "link_not_opened" | "user_action_required";

export type AgentClaimPoll =
  | {
      readonly kind: "issued";
      readonly accessToken: string;
      readonly expiresIn: number;
      readonly scope: string;
      readonly mcpUrl: string;
    }
  | { readonly kind: "pending"; readonly stage: AgentPendingStage }
  | { readonly kind: "slow_down" }
  | { readonly kind: "expired" }
  | { readonly kind: "denied" }
  | { readonly kind: "invalid" };

const INVALID = { kind: "invalid" } as const;

/** The agent side of the claim flow: start a claim, then collect the token. */
export class AgentClaimService {
  constructor(private readonly deps: AgentClaimServiceDependencies) {}

  static fromEnv(env: Env): AgentClaimService {
    const { mcpResource } = requireAgentSignupConfig(env);
    return new AgentClaimService({
      claims: new AgentClaimRepository(env),
      mcpResource,
      notifyConnected: createAgentConnectedNotifier(env),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    });
  }

  async register(
    request: AgentIdentityRequest,
    context: AgentRegistrationContext,
  ): Promise<AgentRegistration> {
    const now = this.deps.now();
    const id = this.deps.newId();
    const claimToken = newClaimToken();
    const attemptToken = newAttemptToken();
    const userCode = newUserCode();
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_SECONDS * 1000);
    const scopes = offeredScopes(request.scope?.split(/\s+/).filter(Boolean) ?? []);
    const clientName = request.client_name ?? DEFAULT_CLIENT_NAME;

    const claim = {
      id,
      claimTokenHash: await sha256Hex(claimToken),
      attemptTokenHash: await sha256Hex(attemptToken),
      userCodeHash: await userCodeHash(attemptToken, userCode),
      clientName,
      tokenName: request.token_name ?? clientName,
      loginHint: request.login_hint ?? null,
      clientIpKey: context.clientIpKey,
      requestedScopes: scopes,
      expiresAt,
    };
    if (!(await this.deps.claims.createWithinLimits(claim, claimLimits(now)))) {
      return { kind: "rate_limited" };
    }

    return {
      kind: "registered",
      grant: {
        registrationId: id,
        claimToken,
        claimTokenExpires: expiresAt.toISOString(),
        scopes,
        userCode,
        verificationUri: verificationUri(context.webOrigin, attemptToken),
        expiresIn: CLAIM_TTL_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      },
    };
  }

  async poll(claimToken: string): Promise<AgentClaimPoll> {
    if (!isClaimToken(claimToken)) return INVALID;
    const claim = await this.deps.claims.findByClaimTokenHash(await sha256Hex(claimToken));
    if (claim === null || claim.status === "redeemed") return INVALID;

    const now = this.deps.now();
    if (claim.status === "denied" || claim.status === "locked") return { kind: "denied" };
    if (claim.expiresAt <= now) return { kind: "expired" };
    if (!(await this.deps.claims.acceptPoll(claim.id, now, earliestPreviousPoll(now)))) {
      return { kind: "slow_down" };
    }
    if (claim.status === "pending") {
      return { kind: "pending", stage: claim.openedAt === null ? "link_not_opened" : "user_action_required" };
    }
    return this.issueToken(claim, now);
  }

  private async issueToken(claim: AgentClaimRecord, now: Date): Promise<AgentClaimPoll> {
    const token = await this.buildToken(claim, now);
    if (token === null) return INVALID;
    const redeemed = await this.deps.claims.redeem(claim.id, token.record, now, MAX_ACTIVE_AGENT_TOKENS_PER_USER);
    if (!redeemed) return INVALID;
    await this.sendConnectedNotice(claim, token.record);
    return {
      kind: "issued",
      accessToken: token.plaintext,
      expiresIn: AGENT_TOKEN_TTL_SECONDS,
      scope: token.record.scopes.join(" "),
      mcpUrl: this.deps.mcpResource,
    };
  }

  /** The token already exists, so a mail problem must not take it from the agent. */
  private async sendConnectedNotice(claim: AgentClaimRecord, token: NewAgentToken): Promise<void> {
    try {
      await this.deps.notifyConnected({
        registrationId: claim.id,
        userId: token.userId,
        agentName: claim.clientName,
        tokenName: claim.tokenName,
        scopes: token.scopes,
      });
    } catch (cause) {
      console.error("Agent connected notice failed.", toSafeErrorLog(cause));
    }
  }

  private async buildToken(
    claim: AgentClaimRecord,
    now: Date,
  ): Promise<{ plaintext: string; record: NewAgentToken } | null> {
    const projectScope = projectScopeClaimSchema.safeParse(claim.approvedProjectScope);
    if (claim.approvedUserId === null || claim.approvedScopes === null || !projectScope.success) {
      return null;
    }
    const plaintext = newAgentToken();
    return {
      plaintext,
      record: {
        userId: claim.approvedUserId,
        tokenHash: await sha256Hex(plaintext),
        tokenName: claim.tokenName,
        clientName: claim.clientName,
        scopes: claim.approvedScopes.filter(isOAuthScope),
        projectScope: projectScope.data,
        grantRef: this.deps.newId(),
        expiresAt: new Date(now.getTime() + AGENT_TOKEN_TTL_SECONDS * 1000),
      },
    };
  }
}

function claimLimits(now: Date) {
  return {
    since: new Date(now.getTime() - HOUR_MS),
    perLoginHint: MAX_CLAIMS_PER_LOGIN_HINT_PER_HOUR,
    perLoginHintAndIp: MAX_CLAIMS_PER_LOGIN_HINT_AND_IP_PER_HOUR,
    perClientIp: MAX_CLAIMS_PER_CLIENT_IP_PER_HOUR,
  };
}

function verificationUri(webOrigin: string, attemptToken: string): string {
  const url = new URL("/oauth/claim", webOrigin);
  url.searchParams.set("attempt", attemptToken);
  return url.href;
}

function earliestPreviousPoll(now: Date): Date {
  return new Date(now.getTime() - POLL_INTERVAL_SECONDS * 1000 + POLL_INTERVAL_TOLERANCE_MS);
}
