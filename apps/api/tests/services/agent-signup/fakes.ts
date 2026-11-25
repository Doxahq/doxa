import { vi } from "vitest";
import type {
  AccountEmailReader,
  AgentClaimApproval,
  AgentClaimLimits,
  AgentClaimRecord,
  AgentClaimStore,
  NewAgentClaim,
  NewAgentToken,
} from "../../../src/repositories/agent-claims";
import { agentTokenEndsAt, type AgentTokenRecord, type AgentTokenStore } from "../../../src/repositories/agent-tokens";
import type { AgentConnectedNotifier } from "../../../src/services/agent-signup/agent-connected-notice";
import { AgentClaimConsentService } from "../../../src/services/agent-signup/agent-claim-consent-service";
import { AgentClaimService } from "../../../src/services/agent-signup/agent-claim-service";
import { OWNER } from "../oauth/fixtures";
import { ownerPolicy } from "../oauth/fixtures";
import type { ProductAnalytics } from "@doxahq/analytics";

export { OWNER, OTHER, PROJECT_A, OTHER_PROJECT } from "../oauth/fixtures";
export const OWNER_EMAIL = "owner@doxa.test";
export const MCP_RESOURCE = "https://mcp.doxa.test/mcp";
export const WEB_ORIGIN = "https://doxa.test";

/** A store with the same conditional behavior as the SQL statements. */
export class MemoryAgentClaimStore implements AgentClaimStore {
  readonly claims = new Map<string, AgentClaimRecord>();

  constructor(private readonly tokens: MemoryAgentTokenStore, private readonly clock: Clock) {}

  async createWithinLimits(claim: NewAgentClaim, limits: AgentClaimLimits): Promise<boolean> {
    const recent = [...this.claims.values()].filter((c) => c.createdAt >= limits.since);
    const byHint = recent.filter((c) => claim.loginHint && c.loginHint === claim.loginHint);
    const byIp = recent.filter((c) => claim.clientIpKey && c.clientIpKey === claim.clientIpKey);
    const byBoth = byHint.filter((c) => c.clientIpKey === claim.clientIpKey);
    if (byIp.length >= limits.perClientIp || byHint.length >= limits.perLoginHint) return false;
    if (byHint.length > 0 && claim.clientIpKey && byBoth.length >= limits.perLoginHintAndIp) return false;
    this.claims.set(claim.id!, {
      ...claim,
      id: claim.id!,
      loginHint: claim.loginHint ?? null,
      clientIpKey: claim.clientIpKey ?? null,
      status: "pending",
      codeAttempts: 0,
      approvedUserId: null,
      approvedScopes: null,
      approvedProjectScope: null,
      openedAt: null,
      lastPolledAt: null,
      createdAt: this.clock.now(),
    });
    return true;
  }

  async findByClaimTokenHash(hash: string): Promise<AgentClaimRecord | null> {
    return [...this.claims.values()].find((c) => c.claimTokenHash === hash) ?? null;
  }

  async findByAttemptTokenHash(hash: string): Promise<AgentClaimRecord | null> {
    return [...this.claims.values()].find((c) => c.attemptTokenHash === hash) ?? null;
  }

  async markOpened(id: string, openedAt: Date): Promise<void> {
    const claim = this.claims.get(id)!;
    if (claim.openedAt === null) this.claims.set(id, { ...claim, openedAt });
  }

  async acceptPoll(id: string, now: Date, earliestPreviousPoll: Date): Promise<boolean> {
    const claim = this.claims.get(id)!;
    if (claim.lastPolledAt !== null && claim.lastPolledAt > earliestPreviousPoll) return false;
    this.claims.set(id, { ...claim, lastPolledAt: now });
    return true;
  }

  async reserveCodeAttempt(id: string, now: Date, maxAttempts: number): Promise<number | null> {
    const claim = this.claims.get(id)!;
    if (claim.status !== "pending" || claim.expiresAt <= now || claim.codeAttempts >= maxAttempts) return null;
    const codeAttempts = claim.codeAttempts + 1;
    this.claims.set(id, { ...claim, codeAttempts });
    return codeAttempts;
  }

  async lock(id: string): Promise<void> {
    const claim = this.claims.get(id)!;
    if (claim.status === "pending") this.claims.set(id, { ...claim, status: "locked" });
  }

  async approve(id: string, approval: AgentClaimApproval, now: Date): Promise<boolean> {
    const claim = this.claims.get(id)!;
    if (claim.status !== "pending" || claim.expiresAt <= now) return false;
    this.claims.set(id, {
      ...claim,
      status: "approved",
      approvedUserId: approval.userId,
      approvedScopes: [...approval.scopes],
      approvedProjectScope: approval.projectScope,
      expiresAt: approval.expiresAt,
    });
    return true;
  }

  async deny(id: string, now: Date): Promise<boolean> {
    const claim = this.claims.get(id)!;
    if (claim.status !== "pending" || claim.expiresAt <= now) return false;
    this.claims.set(id, { ...claim, status: "denied" });
    return true;
  }

  async redeem(id: string, token: NewAgentToken, now: Date, maxActiveTokens: number): Promise<boolean> {
    if ((await this.tokens.countActive(token.userId, now)) >= maxActiveTokens) return false;
    const claim = this.claims.get(id)!;
    if (claim.status !== "approved" || claim.expiresAt <= now) return false;
    this.claims.set(id, { ...claim, status: "redeemed" });
    this.tokens.insert(token, now);
    return true;
  }

  async deleteExpiredBefore(cutoff: Date): Promise<void> {
    for (const [id, claim] of this.claims) if (claim.expiresAt < cutoff) this.claims.delete(id);
  }
}

export class MemoryAgentTokenStore implements AgentTokenStore {
  readonly tokens = new Map<string, AgentTokenRecord>();
  touches = 0;

  insert(token: NewAgentToken, now: Date): void {
    const id = crypto.randomUUID();
    this.tokens.set(id, { ...token, id, grantRef: token.grantRef, createdAt: now, lastUsedAt: null, revokedAt: null });
  }

  async findActiveByHash(tokenHash: string, now: Date): Promise<AgentTokenRecord | null> {
    return [...this.tokens.values()].find((t) => t.tokenHash === tokenHash && isActive(t, now)) ?? null;
  }

  async touch(id: string, now: Date): Promise<void> {
    this.touches += 1;
    this.tokens.set(id, { ...this.tokens.get(id)!, lastUsedAt: now });
  }

  async countActive(userId: string, now: Date): Promise<number> {
    return [...this.tokens.values()].filter((t) => t.userId === userId && isActive(t, now)).length;
  }

  async listActive(userId: string, now: Date): Promise<AgentTokenRecord[]> {
    return [...this.tokens.values()].filter((t) => t.userId === userId && isActive(t, now));
  }

  async revoke(userId: string, id: string, now: Date): Promise<boolean> {
    const token = this.tokens.get(id);
    if (!token || token.userId !== userId || !isActive(token, now)) return false;
    this.tokens.set(id, { ...token, revokedAt: now });
    return true;
  }

  async revokeByHash(tokenHash: string, now: Date): Promise<void> {
    for (const [id, token] of this.tokens) if (token.tokenHash === tokenHash) this.tokens.set(id, { ...token, revokedAt: now });
  }

  async deleteEndedBefore(): Promise<void> {}
}

function isActive(token: AgentTokenRecord, now: Date): boolean {
  return token.revokedAt === null && agentTokenEndsAt(token) > now;
}

export class Clock {
  private time = new Date("2026-11-09T12:00:00.000Z").getTime();

  now = (): Date => new Date(this.time);

  advance(seconds: number): void {
    this.time += seconds * 1000;
  }
}

export function harness(options: { emails?: Record<string, string>; analytics?: ProductAnalytics } = {}) {
  const clock = new Clock();
  const tokens = new MemoryAgentTokenStore();
  const claims = new MemoryAgentClaimStore(tokens, clock);
  const emails = options.emails ?? { [OWNER]: OWNER_EMAIL };
  const accounts: AccountEmailReader = { findEmail: async (userId) => emails[userId] ?? null };
  const projects = ownerPolicy();
  const notifyConnected = vi.fn<AgentConnectedNotifier>(async () => {});
  const agent = new AgentClaimService({
    claims,
    mcpResource: MCP_RESOURCE,
    notifyConnected,
    now: clock.now,
    newId: () => crypto.randomUUID(),
  });
  const consent = new AgentClaimConsentService({
    claims,
    tokens,
    accounts,
    projects,
    now: clock.now,
    ...(options.analytics ? { analytics: options.analytics } : {}),
  });
  return { clock, tokens, claims, agent, consent, notifyConnected };
}

export async function registered(
  context: ReturnType<typeof harness>,
  request: Partial<Parameters<AgentClaimService["register"]>[0]> = {},
  clientIpKey = "203.0.113.9",
) {
  const result = await context.agent.register(
    { type: "service_auth", client_name: "Claude Code", scope: "docs:read docs:write", ...request },
    { clientIpKey, webOrigin: WEB_ORIGIN },
  );
  if (result.kind !== "registered") throw new Error("Expected a registered claim.");
  const attemptToken = new URL(result.grant.verificationUri).searchParams.get("attempt")!;
  return { grant: result.grant, attemptToken };
}
