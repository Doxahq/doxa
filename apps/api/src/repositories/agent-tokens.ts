import { and, count, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";

const { agentTokens } = schema;

export type AgentTokenRecord = typeof agentTokens.$inferSelect;

/** A token that nobody uses for this long stops working, so a forgotten token cannot live on. */
export const AGENT_TOKEN_IDLE_LIMIT_SECONDS = 30 * 24 * 3600;

/** The first moment that the token no longer works. Use resets the idle limit, but never passes `expiresAt`. */
export function agentTokenEndsAt(
  token: Pick<AgentTokenRecord, "createdAt" | "lastUsedAt" | "expiresAt">,
): Date {
  const lastActivity = token.lastUsedAt ?? token.createdAt;
  const idleEnd = lastActivity.getTime() + AGENT_TOKEN_IDLE_LIMIT_SECONDS * 1000;
  return new Date(Math.min(idleEnd, token.expiresAt.getTime()));
}

/** SQL form of `agentTokenEndsAt(token) > now` for a token that is not revoked. */
export function agentTokenIsActive(now: Date) {
  const idleCutoff = idleCutoffFor(now);
  return and(
    isNull(agentTokens.revokedAt),
    gt(agentTokens.expiresAt, now),
    or(
      gt(agentTokens.lastUsedAt, idleCutoff),
      and(isNull(agentTokens.lastUsedAt), gt(agentTokens.createdAt, idleCutoff)),
    ),
  );
}

function idleCutoffFor(now: Date): Date {
  return new Date(now.getTime() - AGENT_TOKEN_IDLE_LIMIT_SECONDS * 1000);
}

export interface AgentTokenStore {
  findActiveByHash(tokenHash: string, now: Date): Promise<AgentTokenRecord | null>;
  touch(id: string, now: Date, staleBefore: Date): Promise<void>;
  countActive(userId: string, now: Date): Promise<number>;
  listActive(userId: string, now: Date, limit: number): Promise<AgentTokenRecord[]>;
  revoke(userId: string, id: string, now: Date): Promise<boolean>;
  revokeByHash(tokenHash: string, now: Date): Promise<void>;
  deleteEndedBefore(cutoff: Date): Promise<void>;
}

export class AgentTokenRepository implements AgentTokenStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async findActiveByHash(tokenHash: string, now: Date): Promise<AgentTokenRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentTokens)
      .where(and(eq(agentTokens.tokenHash, tokenHash), agentTokenIsActive(now)))
      .limit(1);
    return row ?? null;
  }

  async touch(id: string, now: Date, staleBefore: Date): Promise<void> {
    await this.db
      .update(agentTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(agentTokens.id, id),
          or(isNull(agentTokens.lastUsedAt), lt(agentTokens.lastUsedAt, staleBefore)),
        ),
      );
  }

  async countActive(userId: string, now: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(agentTokens)
      .where(this.activeForUser(userId, now));
    return row?.total ?? 0;
  }

  listActive(userId: string, now: Date, limit: number): Promise<AgentTokenRecord[]> {
    return this.db
      .select()
      .from(agentTokens)
      .where(this.activeForUser(userId, now))
      .orderBy(desc(agentTokens.createdAt))
      .limit(limit);
  }

  async revoke(userId: string, id: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(agentTokens)
      .set({ revokedAt: now })
      .where(and(eq(agentTokens.id, id), this.activeForUser(userId, now)))
      .returning({ id: agentTokens.id });
    return rows.length > 0;
  }

  async revokeByHash(tokenHash: string, now: Date): Promise<void> {
    await this.db
      .update(agentTokens)
      .set({ revokedAt: now })
      .where(and(eq(agentTokens.tokenHash, tokenHash), isNull(agentTokens.revokedAt)));
  }

  async deleteEndedBefore(cutoff: Date): Promise<void> {
    const idleCutoff = idleCutoffFor(cutoff);
    await this.db
      .delete(agentTokens)
      .where(
        or(
          lt(agentTokens.expiresAt, cutoff),
          lt(agentTokens.revokedAt, cutoff),
          lt(agentTokens.lastUsedAt, idleCutoff),
          and(isNull(agentTokens.lastUsedAt), lt(agentTokens.createdAt, idleCutoff)),
        ),
      );
  }

  private activeForUser(userId: string, now: Date) {
    return and(eq(agentTokens.userId, userId), agentTokenIsActive(now));
  }
}
