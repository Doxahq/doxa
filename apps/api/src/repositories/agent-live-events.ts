import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, lt, lte, max, ne, sql } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";

const { agentApprovalRequests, agentLiveEvents, agentTokens } = schema;

/** A row without its diff, which only `findDiff` loads. */
export type AgentLiveEventRecord = Omit<typeof agentLiveEvents.$inferSelect, "diff"> & {
  hasDiff: boolean;
};
export type NewAgentLiveEvent = Omit<
  typeof agentLiveEvents.$inferInsert,
  "projectId" | "seq" | "occurredAt"
>;

export interface AgentLiveEventStore {
  append(projectId: string, events: readonly NewAgentLiveEvent[]): Promise<void>;
}

export interface AgentLiveActivityReader {
  /** Newest first. */
  listRecent(projectId: string, since: Date, limit: number): Promise<AgentLiveEventRecord[]>;
  /** Oldest first. */
  listAfter(projectId: string, afterSeq: number, since: Date, limit: number): Promise<AgentLiveEventRecord[]>;
  /** Null for an unknown event, one without a diff, or one older than `since`. */
  findDiff(projectId: string, seq: number, since: Date): Promise<string | null>;
  pendingApprovalGrantRefs(projectId: string): Promise<ReadonlySet<string>>;
  tokenNamesByGrantRef(grantRefs: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** Bounds the storage of one busy agent. The panel shows far fewer. */
const MAX_EVENTS_PER_PROJECT = 1_000;

const { diff: _omittedDiff, ...eventColumnsWithoutDiff } = getTableColumns(agentLiveEvents);
const eventSelection = {
  ...eventColumnsWithoutDiff,
  hasDiff: sql<boolean>`${agentLiveEvents.diff} is not null`,
};

export const noLiveEvents: AgentLiveEventStore = { append: async () => undefined };

export class AgentLiveEventRepository implements AgentLiveEventStore, AgentLiveActivityReader {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  /** The lock gives commit order to `seq`. A serial ID can commit out of order. */
  async append(projectId: string, events: readonly NewAgentLiveEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-live:${projectId}`}))`);
      const [row] = await tx
        .select({ latest: max(agentLiveEvents.seq) })
        .from(agentLiveEvents)
        .where(eq(agentLiveEvents.projectId, projectId));
      const latest = Number(row?.latest ?? 0);
      await tx
        .insert(agentLiveEvents)
        .values(events.map((event, index) => ({ ...event, projectId, seq: latest + index + 1 })));
      await tx
        .delete(agentLiveEvents)
        .where(
          and(
            eq(agentLiveEvents.projectId, projectId),
            lte(agentLiveEvents.seq, latest + events.length - MAX_EVENTS_PER_PROJECT),
          ),
        );
    });
  }

  listRecent(projectId: string, since: Date, limit: number): Promise<AgentLiveEventRecord[]> {
    return this.db
      .select(eventSelection)
      .from(agentLiveEvents)
      .where(and(eq(agentLiveEvents.projectId, projectId), gte(agentLiveEvents.occurredAt, since)))
      .orderBy(desc(agentLiveEvents.seq))
      .limit(limit);
  }

  listAfter(
    projectId: string,
    afterSeq: number,
    since: Date,
    limit: number,
  ): Promise<AgentLiveEventRecord[]> {
    return this.db
      .select(eventSelection)
      .from(agentLiveEvents)
      .where(
        and(
          eq(agentLiveEvents.projectId, projectId),
          gt(agentLiveEvents.seq, afterSeq),
          gte(agentLiveEvents.occurredAt, since),
        ),
      )
      .orderBy(asc(agentLiveEvents.seq))
      .limit(limit);
  }

  async findDiff(projectId: string, seq: number, since: Date): Promise<string | null> {
    const [row] = await this.db
      .select({ diff: agentLiveEvents.diff })
      .from(agentLiveEvents)
      .where(
        and(
          eq(agentLiveEvents.projectId, projectId),
          eq(agentLiveEvents.seq, seq),
          gte(agentLiveEvents.occurredAt, since),
        ),
      )
      .limit(1);
    return row?.diff ?? null;
  }

  async pendingApprovalGrantRefs(projectId: string): Promise<ReadonlySet<string>> {
    const rows = await this.db
      .selectDistinct({ grantRef: agentApprovalRequests.grantRef })
      .from(agentApprovalRequests)
      .where(and(eq(agentApprovalRequests.projectId, projectId), eq(agentApprovalRequests.status, "pending")));
    return new Set(rows.map((row) => row.grantRef));
  }

  async tokenNamesByGrantRef(grantRefs: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (grantRefs.length === 0) return new Map();
    const rows = await this.db
      .select({ grantRef: agentTokens.grantRef, tokenName: agentTokens.tokenName })
      .from(agentTokens)
      .where(inArray(agentTokens.grantRef, [...grantRefs]));
    return new Map(rows.map((row) => [row.grantRef, row.tokenName]));
  }

  /**
   * Keeps the newest row of each project, so that a project's `seq` never
   * restarts and a reader's position stays valid. That row loses its text.
   */
  async deleteExpired(cutoff: Date): Promise<void> {
    await this.db.delete(agentLiveEvents).where(
      and(
        lt(agentLiveEvents.occurredAt, cutoff),
        sql`${agentLiveEvents.seq} < (select max(newest.seq) from agent_live_events newest where newest.project_id = ${agentLiveEvents.projectId})`,
      ),
    );
    await this.db
      .update(agentLiveEvents)
      .set({ clientName: "", pageHref: null, pageTitle: null, detail: null, note: null, diff: null })
      .where(and(lt(agentLiveEvents.occurredAt, cutoff), ne(agentLiveEvents.clientName, "")));
  }
}
