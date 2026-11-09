import { and, count, eq, gt, gte, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { agentTokenIsActive } from "./agent-tokens";

const { agentClaims, agentTokens, user } = schema;

export type AgentClaimRecord = typeof agentClaims.$inferSelect;
export type NewAgentClaim = Pick<
  typeof agentClaims.$inferInsert,
  | "id"
  | "claimTokenHash"
  | "attemptTokenHash"
  | "userCodeHash"
  | "clientName"
  | "tokenName"
  | "loginHint"
  | "clientIpKey"
  | "requestedScopes"
  | "expiresAt"
>;
export type NewAgentToken = Pick<
  typeof agentTokens.$inferInsert,
  | "userId"
  | "tokenHash"
  | "tokenName"
  | "clientName"
  | "scopes"
  | "projectScope"
  | "grantRef"
  | "expiresAt"
>;

export interface AgentClaimLimits {
  readonly since: Date;
  readonly perLoginHint: number;
  readonly perLoginHintAndIp: number;
  readonly perClientIp: number;
}

export interface AgentClaimApproval {
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly projectScope: unknown;
  readonly expiresAt: Date;
}

/** Each state change is one conditional statement, so that parallel requests cannot both win. */
export interface AgentClaimStore {
  /** False when a limit is reached. The count and the insert are one locked transaction. */
  createWithinLimits(claim: NewAgentClaim, limits: AgentClaimLimits): Promise<boolean>;
  findByClaimTokenHash(hash: string): Promise<AgentClaimRecord | null>;
  findByAttemptTokenHash(hash: string): Promise<AgentClaimRecord | null>;
  markOpened(id: string, openedAt: Date): Promise<void>;
  /** False when the previous poll came after `earliestPreviousPoll`. */
  acceptPoll(id: string, now: Date, earliestPreviousPoll: Date): Promise<boolean>;
  /** Spends one attempt before the code is compared. Null when no attempt is left. */
  reserveCodeAttempt(id: string, now: Date, maxAttempts: number): Promise<number | null>;
  lock(id: string): Promise<void>;
  approve(id: string, approval: AgentClaimApproval, now: Date): Promise<boolean>;
  deny(id: string, now: Date): Promise<boolean>;
  /** Ends the claim and creates its token in one transaction. False when redeemed or at the token limit. */
  redeem(id: string, token: NewAgentToken, now: Date, maxActiveTokens: number): Promise<boolean>;
  deleteExpiredBefore(cutoff: Date): Promise<void>;
}

export class AgentClaimRepository implements AgentClaimStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  createWithinLimits(claim: NewAgentClaim, limits: AgentClaimLimits): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const { loginHint = null, clientIpKey = null } = claim;
      await lockKeys(tx, [
        ...(loginHint ? [`agent-claim-hint:${loginHint}`] : []),
        ...(clientIpKey ? [`agent-claim-ip:${clientIpKey}`] : []),
      ]);
      const recent = (...filters: SQL[]) => countRows(tx, and(gte(agentClaims.createdAt, limits.since), ...filters));
      const byHint = loginHint ? eq(agentClaims.loginHint, loginHint) : null;
      const byIp = clientIpKey ? eq(agentClaims.clientIpKey, clientIpKey) : null;
      if (byIp && (await recent(byIp)) >= limits.perClientIp) return false;
      if (byHint && (await recent(byHint)) >= limits.perLoginHint) return false;
      if (byHint && byIp && (await recent(byHint, byIp)) >= limits.perLoginHintAndIp) return false;
      await tx.insert(agentClaims).values(claim);
      return true;
    });
  }

  async findByClaimTokenHash(hash: string): Promise<AgentClaimRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentClaims)
      .where(eq(agentClaims.claimTokenHash, hash))
      .limit(1);
    return row ?? null;
  }

  async findByAttemptTokenHash(hash: string): Promise<AgentClaimRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentClaims)
      .where(eq(agentClaims.attemptTokenHash, hash))
      .limit(1);
    return row ?? null;
  }

  async markOpened(id: string, openedAt: Date): Promise<void> {
    await this.db
      .update(agentClaims)
      .set({ openedAt })
      .where(and(eq(agentClaims.id, id), isNull(agentClaims.openedAt)));
  }

  async acceptPoll(id: string, now: Date, earliestPreviousPoll: Date): Promise<boolean> {
    const rows = await this.db
      .update(agentClaims)
      .set({ lastPolledAt: now })
      .where(
        and(
          eq(agentClaims.id, id),
          or(isNull(agentClaims.lastPolledAt), lte(agentClaims.lastPolledAt, earliestPreviousPoll)),
        ),
      )
      .returning({ id: agentClaims.id });
    return rows.length > 0;
  }

  async reserveCodeAttempt(id: string, now: Date, maxAttempts: number): Promise<number | null> {
    const [row] = await this.db
      .update(agentClaims)
      .set({ codeAttempts: sqlIncrement() })
      .where(
        and(
          this.pendingAndLive(id, now),
          lt(agentClaims.codeAttempts, maxAttempts),
        ),
      )
      .returning({ codeAttempts: agentClaims.codeAttempts });
    return row?.codeAttempts ?? null;
  }

  async lock(id: string): Promise<void> {
    await this.db
      .update(agentClaims)
      .set({ status: "locked" })
      .where(and(eq(agentClaims.id, id), eq(agentClaims.status, "pending")));
  }

  async approve(id: string, approval: AgentClaimApproval, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(agentClaims)
      .set({
        status: "approved",
        approvedUserId: approval.userId,
        approvedScopes: [...approval.scopes],
        approvedProjectScope: approval.projectScope,
        expiresAt: approval.expiresAt,
      })
      .where(this.pendingAndLive(id, now))
      .returning({ id: agentClaims.id });
    return rows.length > 0;
  }

  async deny(id: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(agentClaims)
      .set({ status: "denied" })
      .where(this.pendingAndLive(id, now))
      .returning({ id: agentClaims.id });
    return rows.length > 0;
  }

  redeem(id: string, token: NewAgentToken, now: Date, maxActiveTokens: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await lockKeys(tx, [`agent-tokens:${token.userId}`]);
      const [active] = await tx
        .select({ total: count() })
        .from(agentTokens)
        .where(and(eq(agentTokens.userId, token.userId), agentTokenIsActive(now)));
      if ((active?.total ?? 0) >= maxActiveTokens) return false;
      const rows = await tx
        .update(agentClaims)
        .set({ status: "redeemed" })
        .where(and(eq(agentClaims.id, id), eq(agentClaims.status, "approved"), gt(agentClaims.expiresAt, now)))
        .returning({ id: agentClaims.id });
      if (rows.length === 0) return false;
      await tx.insert(agentTokens).values(token);
      return true;
    });
  }

  async deleteExpiredBefore(cutoff: Date): Promise<void> {
    await this.db.delete(agentClaims).where(lt(agentClaims.expiresAt, cutoff));
  }

  private pendingAndLive(id: string, now: Date) {
    return and(eq(agentClaims.id, id), eq(agentClaims.status, "pending"), gt(agentClaims.expiresAt, now));
  }
}

function sqlIncrement() {
  return sql`${agentClaims.codeAttempts} + 1`;
}

type DbTransaction = Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];

/** Sorted, so that two transactions cannot wait for each other. Released at commit. */
async function lockKeys(tx: DbTransaction, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

async function countRows(tx: DbTransaction, where: SQL | undefined): Promise<number> {
  const [row] = await tx.select({ total: count() }).from(agentClaims).where(where);
  return row?.total ?? 0;
}

export interface AccountEmailReader {
  findEmail(userId: string): Promise<string | null>;
}

export class AccountEmailRepository implements AccountEmailReader {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async findEmail(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.email ?? null;
  }
}
