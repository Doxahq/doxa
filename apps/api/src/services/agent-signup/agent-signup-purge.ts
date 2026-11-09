import type { DbEnv } from "@doxahq/db";
import { AgentClaimRepository, type AgentClaimStore } from "../../repositories/agent-claims";
import { AgentTokenRepository, type AgentTokenStore } from "../../repositories/agent-tokens";

const CLAIM_RETENTION_MS = 24 * 3600 * 1000;
const ENDED_TOKEN_RETENTION_MS = 30 * 24 * 3600 * 1000;

export interface AgentSignupPurgeDependencies {
  claims: Pick<AgentClaimStore, "deleteExpiredBefore">;
  tokens: Pick<AgentTokenStore, "deleteEndedBefore">;
  now: () => Date;
}

/** Cron cleanup. Claims stay for one day, so that a recent abuse report can still find them. */
export class AgentSignupPurge {
  constructor(private readonly deps: AgentSignupPurgeDependencies) {}

  static fromEnv(env: DbEnv): AgentSignupPurge {
    return new AgentSignupPurge({
      claims: new AgentClaimRepository(env),
      tokens: new AgentTokenRepository(env),
      now: () => new Date(),
    });
  }

  async run(): Promise<void> {
    const now = this.deps.now().getTime();
    await this.deps.claims.deleteExpiredBefore(new Date(now - CLAIM_RETENTION_MS));
    await this.deps.tokens.deleteEndedBefore(new Date(now - ENDED_TOKEN_RETENTION_MS));
  }
}
